import {QueryClientImpl as PstakeQuery} from "persistenceonejs/pstake/liquidstakeibc/v1beta1/query.js"
import {QueryClientImpl as StakingQuery} from "persistenceonejs/cosmos/staking/v1beta1/query.js"
import {QueryClientImpl as SlashingQuery} from "persistenceonejs/cosmos/slashing/v1beta1/query.js"
import {QueryClientImpl as GovQuery} from "cosmjs-types/cosmos/gov/v1beta1/query.js"
import {
    AllPaginatedQuery,
    ChangeAddressPrefix,
    CreateSigningClientFromAddress,
    RpcClient,
    ValidatorPubkeyToBech32
} from "./helper.js";
import {
    addresses,
    chainInfos,
    ENVIRONMENT,
    ENVS,
    LIQUIDSTAKEIBC_ADMIN,
    LIQUIDSTAKEIBC_ADMIN_TESTNET
} from "./constants.js";
import {assertIsDeliverTxSuccess, decodeCosmosSdkDecFromProto} from "@cosmjs/stargate";
import {MsgExec} from "cosmjs-types/cosmos/authz/v1beta1/tx.js";
import {MsgUpdateHostChain} from "persistenceonejs/pstake/liquidstakeibc/v1beta1/msgs.js";
import {BondStatus, bondStatusToJSON, Description} from "persistenceonejs/cosmos/staking/v1beta1/staking.js";
import {Decimal} from "@cosmjs/math";
import {ProposalStatus} from "cosmjs-types/cosmos/gov/v1beta1/gov.js";
import {fromDuration, fromTimestamp} from "cosmjs-types/helpers.js";
import * as fs from "fs";

async function UpdateHostChainValSet(persistenceChainInfo, cosmosChainInfo, granteePersistenceAddr, AuthzGranterAddr) {
    const [persistenceTMClient, persistenceRpcClient] = await RpcClient(persistenceChainInfo.rpc)
    const pstakeQueryClient = new PstakeQuery(persistenceRpcClient)
    let hostChain = await pstakeQueryClient.HostChain({chainId: cosmosChainInfo.chainID})

    const [cosmosTMClient, cosmosRpcClient] = await RpcClient(cosmosChainInfo.rpc)
    const cosmosStakingClient = new StakingQuery(cosmosRpcClient)
    const cosmosGovClient = new GovQuery(cosmosRpcClient)
    const cosmosSlashingClient = new SlashingQuery(cosmosRpcClient)

    // query all bonded vals
    let allValsBonded = await AllPaginatedQuery(cosmosStakingClient.Validators, {status: bondStatusToJSON(BondStatus.BOND_STATUS_BONDED)}, "validators")
    console.log("all bonded vals in this iteration")
    // console.dir(allValsBonded, {'maxArrayLength': null})

    // put it into struct that has all info
    let allVals = []
    for (let validator of allValsBonded) {
        let valmap = {
            valoper: validator.operatorAddress,
            validator: validator,
            signingInfo: {},
            deny: false,
            denyReason: [],
            commissionScore: 0,
            uptimeScore: 0,
            govScore: 0,
            votingPowerScore: 0,
            blocksMissedScore: 0,
            validatorBondScore: 0,
            overAllValidatorScore: 0,
            weight: 0,
        }
        allVals.push(valmap)
    }
    allVals = await UpdateSigningInfosToValidators(cosmosSlashingClient, allVals, cosmosChainInfo.pstakeConfig.valconsPrefix)

    // Reject vals based on deny list
    allVals = FilterDenyList(allVals, cosmosChainInfo.pstakeConfig.denyListVals)

    // reject/filter on commission, calculate scores
    allVals = FilterOnCommission(allVals, cosmosChainInfo.pstakeConfig.commission)

    // reject/filter on uptime, calculate scores
    allVals = FilterOnUptime(allVals, cosmosChainInfo.pstakeConfig.uptime)

    // reject/filter on Gov in last N days, calculate scores
    allVals = await FilterOnGov(cosmosGovClient, allVals, cosmosChainInfo.pstakeConfig.gov, cosmosChainInfo.prefix)

    // reject/filter on voting power, calculate scores
    allVals = FilterOnVotingPower(allVals, cosmosChainInfo.pstakeConfig.votingPower)

    // reject/filter on blocks missed in signed_blocks_window
    allVals = FilterOnBlocksMissed(cosmosSlashingClient, allVals, cosmosChainInfo.pstakeConfig.blocksMissed)

    // reject/filter time in active set, calculate scores
    allVals = await FilterOnTimeActiveSet(allVals, cosmosChainInfo.pstakeConfig.timeInActiveSet)

    // reject/ filter on slashing events, calculate scores
    allVals = await FilterOnSlashingEvents(cosmosTMClient, allVals, cosmosChainInfo.pstakeConfig.slashingEvents)

    // reject/ filter on validator bond, calculate scores
    if (hostChain.hostChain.flags.lsm === true) {
        allVals = await FilterOnValidatorBond(cosmosStakingClient, allVals, cosmosChainInfo.pstakeConfig.validatorBond)
    }
    // console.dir(allVals, {'maxArrayLength': null})

    for (let i = 0; i < allVals.length; i++) {
        let valScore = CalculateValidatorFinalScore(allVals[i], cosmosChainInfo.pstakeConfig, hostChain.hostChain.flags.lsm)
        allVals[i].overAllValidatorScore = valScore
    }
    let totalDenom = 0
    for (let i = 0; i < allVals.length; i++) {
        if (allVals[i].deny === true) {
            continue
        }
        totalDenom = totalDenom + allVals[i].overAllValidatorScore
    }
    for (let i = 0; i < allVals.length; i++) {
        if (allVals[i].deny === true) {
            continue
        }
        allVals[i].weight = allVals[i].overAllValidatorScore / totalDenom
    }

    // Find validators which are not yet part of pstake validators
    let add_vals = []
    for (let i = 0; i < allVals.length; i++) {
        if (allVals[i].deny === true) {
            continue
        }
        let found = false
        for (let j = 0; j < hostChain.hostChain.validators.length; j++) {
            if (allVals[i].valoper === hostChain.hostChain.validators[j].operatorAddress) {
                found = true
            }
        }
        if (!found) {
            add_vals.push(allVals[i].valoper)
        }
    }

    let kvUpdates = []
    // add kv updates to add_validators
    for (let i = 0; i < add_vals.length; i++) {
        kvUpdates.push({
            key: "add_validator",
            value: {
                operator_address: add_vals[i],
                status: "BOND_STATUS_UNSPECIFIED",
                weight: "0",
                delegated_amount: "0",
                exchange_rate: "1"
            }
        })
        kvUpdates.push({
            key: "validator_update",
            value: add_vals[i]
        })
    }

    // add kv updates to set weight
    let sum = 0
    for (let i = 0; i < allVals.length; i++) {
        if (allVals[i].deny === true) {
            continue
        }

        // to scratch float approximations
        let sum2 = sum + allVals[i].weight
        if (sum2 > 1) {
            allVals[i].weight = 1 - sum
        }
        sum = sum2
        kvUpdates.push({
            key: "validator_weight",
            value: `${allVals[i].valoper},${allVals[i].weight}`
        })
    }
    // allow all data to be printed, bigint won't serialize to string
    for (let i = 0; i < allVals.length; i++) {
        allVals[i].moniker = allVals[i].validator.description.moniker
        allVals[i].validator = {}
        allVals[i].signingInfo = {}
    }
    fs.writeFileSync('data.json', JSON.stringify(allVals));
    console.log("find data.json")
    if (kvUpdates.length === 0) {
        console.log("no kv updates, total kv updates:", kvUpdates.length)
        return
    } else {
        console.log("total kv updates:", kvUpdates.length)
    }
    const msgUpdateHostChain = {
        typeUrl: "/pstake.liquidstakeibc.v1beta1.MsgUpdateHostChain",
        value: MsgUpdateHostChain.fromPartial({
            authority: AuthzGranterAddr,
            chainId: cosmosChainInfo.chainID,
            updates: kvUpdates
        })
    }
    console.log(JSON.stringify(msgUpdateHostChain))

    const msg = {
        typeUrl: "/cosmos.authz.v1beta1.MsgExec",
        value: MsgExec.fromPartial({
            grantee: granteePersistenceAddr.address,
            msgs: [{
                typeUrl: msgUpdateHostChain.typeUrl,
                value: MsgUpdateHostChain.encode(msgUpdateHostChain.value).finish()
            }]
        })
    }
    // console.log("msg: ", JSON.stringify(msg))

    // const signingPersistenceClient = await CreateSigningClientFromAddress(granteePersistenceAddr)
    // const response = await signingPersistenceClient.signAndBroadcast(granteePersistenceAddr.address, [msg], 1.5, "Auto validator update check")
    // console.log(JSON.stringify(response))
    // assertIsDeliverTxSuccess(response)
}

function FilterDenyList(validators, denylist, reason = {name: "denylist", description: "Is part of deny list"}) {
    for (let i = 0; i < validators.length; i++) {
        for (let denyVal of denylist) {
            if (validators[i].valoper === denyVal.valAddr) {
                validators[i].deny = true
                validators[i].denyReason.push(reason)
                break
            }
        }
    }
    return validators
}

function FilterOnCommission(validators, commissionConfig, reason = {name: "commission", description: ""}) {
    for (let i = 0; i < validators.length; i++) {
        let validatorCommission = decodeCosmosSdkDecFromProto(validators[i].validator.commission.commissionRates.rate).toFloatApproximation()

        if (validatorCommission > commissionConfig.max || validatorCommission < commissionConfig.min) {
            validators[i].deny = true
            let submitReason = {}
            submitReason.name = reason.name
            submitReason.description = `Required commission between ${commissionConfig.min} and ${commissionConfig.max}, found ${validatorCommission}`
            validators[i].denyReason.push(submitReason)
        } else {
            //calculate score
            validators[i].commissionScore = CalculateScore(validatorCommission, commissionConfig.max, commissionConfig.max, commissionConfig.min)
        }
    }
    return validators
}

function FilterOnUptime(validators, uptimeConfig, reason = {name: "uptime", description: ""}) {
    for (let i = 0; i < validators.length; i++) {
        // TODO queryUptime
        //  Remove random
        // let valUptime = 0.89 + Math.random() / 10
        let valUptime = 0.95

        if (valUptime < uptimeConfig.min) {
            validators[i].deny = true
            let submitReason = {}
            submitReason.name = reason.name
            submitReason.description = `Required to be greater than ${uptimeConfig.min}, found ${valUptime} `
            validators[i].denyReason.push(submitReason)
        } else {
            //calculate score
            validators[i].uptimeScore = CalculateScore(valUptime, uptimeConfig.min, uptimeConfig.max, uptimeConfig.min)
        }
    }
    return validators
}

async function FilterOnGov(govQueryClient, validators, govConfig, hostChainPrefix, reason = {
    name: "governance participation",
    description: ""
}) {
    let proposals = await AllPaginatedQuery(govQueryClient.Proposals, {
        proposalStatus: ProposalStatus.PROPOSAL_STATUS_UNSPECIFIED,
        voter: "",
        depositor: ""
    }, "proposals")
    let timeNow = new Date(Date.now())
    let timeDelta = new Date().setTime(govConfig.lastNDays * 24 * 60 * 60 * 1000) // days to milliseconds
    let zeroTime = new Date().setTime(0)
    let minProposalID = 0
    let maxProposalID = 0 // is actually in voting period
    let totalCompleteProposals = 0
    for (let i = 0; i < proposals.length; i++) {
        let votingEndTime = fromTimestamp(proposals[i].votingEndTime)
        let diff = timeNow - votingEndTime
        if (diff < timeDelta && diff > zeroTime) {
            if (minProposalID === 0) {
                minProposalID = proposals[i].proposalId.toNumber()

            }
            totalCompleteProposals++
        }
        if (diff < zeroTime && maxProposalID === 0) {
            maxProposalID = proposals[i].proposalId.toNumber()
        }
    }
    console.log(minProposalID, maxProposalID, totalCompleteProposals)

    // TODO async this
    for (let i = 0; i < validators.length; i++) {

        // if (i === 1 || i === 2) {
        if (i === 1) {
            let voterAddr = ChangeAddressPrefix(validators[i].valoper, hostChainPrefix)

            // votes are deleted once proposal is passed, either need to query events or

            let count = 0
            // for (let valProposal of valProposals) {
            //     if (valProposal.proposalId.toNumber() >= minProposalID && valProposal.proposalId.toNumber() < maxProposalID) {
            //         count++
            //     }
            // }
            // console.log(validators[i].validator.description.moniker, count)
        }

        // if (not_in_bounds) {
        //     validators[i].deny = true
        //     let submitReason = {}
        //     submitReason.name = reason.name
        //     submitReason.description = `Required between ${} and ${} , found ${} `
        //     validators[i].denyReason.push(submitReason)
        // } else {
        //     //calculate score
        //     validators[i].Score_metric = CalculateScore(validatorCommission, commissionConfig.max, commissionConfig.max, commissionConfig.min)
        //     handle 0 totalcountproposals case.
        // }
    }
    return validators
}

function FilterOnVotingPower(validators, votingPowerConfig, reason = {name: "VotingPower", description: ""}) {
    let sum = Decimal.zero(18)
    for (let i = 0; i < validators.length; i++) {
        let tokens = decodeCosmosSdkDecFromProto(validators[i].validator.tokens)
        sum = sum.plus(tokens)
    }

    for (let i = 0; i < validators.length; i++) {
        let tokens = decodeCosmosSdkDecFromProto(validators[i].validator.tokens)
        let vp = tokens.toFloatApproximation() / sum.toFloatApproximation()
        if (vp < votingPowerConfig.min || vp > votingPowerConfig.max) {
            validators[i].deny = true
            let submitReason = {}
            submitReason.name = reason.name
            submitReason.description = `Required between ${votingPowerConfig.min} and ${votingPowerConfig.max} , found ${vp} `
            validators[i].denyReason.push(submitReason)
        } else {
            //calculate score
            validators[i].votingPowerScore = CalculateScore(vp, votingPowerConfig.max, votingPowerConfig.max, votingPowerConfig.min)
        }
    }
    return validators
}

function FilterOnBlocksMissed(cosmosSlashingClient, validators, blockmissedConfig,
                              reason = {
                                  name: "blocks missed in sign_window",
                                  description: ""
                              }) {

    for (let i = 0; i < validators.length; i++) {
        let blocksMissed = Number(validators[i].signingInfo.missedBlocksCounter)
        if (blocksMissed > blockmissedConfig.max) {
            validators[i].deny = true
            let submitReason = {}
            submitReason.name = reason.name
            submitReason.description = `Required between ${blockmissedConfig.min} and ${blockmissedConfig.max} , found ${blocksMissed} `
            validators[i].denyReason.push(submitReason)
        } else {
            //calculate score
            validators[i].blocksMissedScore = CalculateScore(blocksMissed, blockmissedConfig.max, blockmissedConfig.max, blockmissedConfig.min)
        }
    }
    return validators
}

function FilterOnTimeActiveSet(validators, timeActiveSetConfig, reason = {
    name: "Time in ActiveSet",
    description: ""
}) {
    // for (let i = 0; i < validators.length; i++) {
    //     let startHeight =  Number(validators[i].signingInfo.startHeight)
    //     if (not_in_bounds) {
    //         validators[i].deny = true
    //         let submitReason = {}
    //         submitReason.name = reason.name
    //         submitReason.description = `Required between ${} and ${} , found ${} `
    //         validators[i].denyReason.push(submitReason)
    //     } else {
    //         //calculate score
    //         validators[i].Score_metric = CalculateScore(validatorCommission, commissionConfig.max, commissionConfig.max, commissionConfig.min)
    //     }
    // }
    return validators
}

async function FilterOnSlashingEvents(cosmosTMClient, validators, slashingConfig, reason = {
    name: "Slashing",
    description: ""
}) {
    let blockHeightBeforeNDays = await BlockNDaysAgo(cosmosTMClient, slashingConfig.lastNDays)
    for (let i = 0; i < validators.length; i++) {
        let startHeight = Number(validators[i].signingInfo.startHeight)
        if (startHeight > blockHeightBeforeNDays) {
            validators[i].deny = true
            let submitReason = {}
            submitReason.name = reason.name
            submitReason.description = `Required greater than ${blockHeightBeforeNDays} , found ${startHeight} `
            validators[i].denyReason.push(submitReason)
        }
    }
    return validators
}

async function FilterOnValidatorBond(stakingClient, validators, validatorBondConfig, reason = {
    name: "validator bond",
    description: ""
}) {
    let stakingParams = await stakingClient.Params({})
    let globalLSMCap = decodeCosmosSdkDecFromProto(stakingParams.params.globalLiquidStakingCap)
    let validatorLSMCap = decodeCosmosSdkDecFromProto(stakingParams.params.validatorLiquidStakingCap)
    let validatorBondFactor = decodeCosmosSdkDecFromProto(stakingParams.params.validatorBondFactor)
    let stakingPool = await stakingClient.Pool({})
    let bondedTokens = Number(stakingPool.pool.bondedTokens)

    let globalLSMCapTokens = bondedTokens * globalLSMCap.toFloatApproximation()


    for (let i = 0; i < validators.length; i++) {

        let tokenShareRatio = validators[i].validator.tokens / validators[i].validator.delegatorShares

        let valCap = Math.min(+validators[i].validator.delegatorShares * validatorLSMCap, +validators[i].validator.validatorBondShares * validatorBondFactor)
        let valLSMCapacity = (valCap - validators[i].validator.liquidShares) * tokenShareRatio / globalLSMCapTokens

        if (valLSMCapacity < validatorBondConfig.min || valLSMCapacity > validatorBondConfig.max) {
            validators[i].deny = true
            let submitReason = {}
            submitReason.name = reason.name
            submitReason.description = `Required between ${validatorBondConfig.min} and ${validatorBondConfig.max} , found ${valLSMCapacity} `
            validators[i].denyReason.push(submitReason)
        } else {
            //calculate score
            validators[i].validatorBondScore = CalculateScore(valLSMCapacity, validatorBondConfig.min, validatorBondConfig.max, validatorBondConfig.min)
        }
    }
    return validators
}

function CalculateScore(val, revOptimal, max, min, normalizationFactor = 100) {
    return +(Math.abs(val - revOptimal) * normalizationFactor / Math.abs(max - min)).toFixed(2)
}

function CalculateValidatorFinalScore(validator, config, lsmFlag) {

    // console.log("-----", validator.valoper)
    // console.log(validator.commissionScore, config.commission.weight)
    // console.log(validator.uptimeScore, config.uptime.weight)
    // console.log(validator.govScore, config.gov.weight)
    // console.log(validator.votingPowerScore, config.votingPower.weight)
    // console.log(validator.blocksMissedScore, config.blocksMissed.weight)
    // console.log(validator.validatorBondScore, config.validatorBond.weight)
    let numerator = (validator.commissionScore * config.commission.weight) +
        (validator.uptimeScore * config.uptime.weight) +
        (validator.govScore * config.gov.weight) +
        (validator.votingPowerScore * config.votingPower.weight) +
        (validator.blocksMissedScore * config.blocksMissed.weight)
    if (lsmFlag) {
        numerator = numerator + (validator.validatorBondScore * config.validatorBond.weight)
    }
    let denominator = config.commission.weight +
        config.uptime.weight +
        config.gov.weight +
        config.votingPower.weight +
        config.blocksMissed.weight
    if (lsmFlag) {
        denominator = denominator + config.validatorBond.weight
    }
    denominator = denominator * 100

    return +(numerator / denominator)
}

async function UpdateSigningInfosToValidators(cosmosSlashingClient, validators, valconsPrefix) {
    let infos = await AllPaginatedQuery(cosmosSlashingClient.SigningInfos, {}, "info")

    // TODO async this loop
    for (let i = 0; i < validators.length; i++) {
        let found = false
        let validatorConsAddr = ValidatorPubkeyToBech32(validators[i].validator.consensusPubkey, valconsPrefix)
        for (let j = 0; j < infos.length; j++) {
            let signingInfo = infos[j]
            if (signingInfo.address === "") {
                continue
            }

            if (validatorConsAddr === signingInfo.address) {
                found = true
                validators[i].signingInfo = signingInfo
                break
            }
        }
        // No clue why there is a need to handle this case..
        if (!found) {
            let info = await cosmosSlashingClient.SigningInfo({consAddress: validatorConsAddr})
            found = true
            validators[i].signingInfo = info.valSigningInfo
        }
    }
    return validators
}

// Not the most accurate, might be even less during upgrades
async function BlockNDaysAgo(queryClient, N) {
    const blockNow = await queryClient.block()
    const factor = 10000
    const blockOld = await queryClient.block(Number(blockNow.block.header.height) - factor)

    const timeNow = new Date(blockNow.block.header.time)
    const timeFactorAgo = new Date(blockOld.block.header.time)

    const avgBlockTime = (timeNow.getTime() - timeFactorAgo.getTime()) / factor

    const timeDelta = new Date().setTime(N * 24 * 60 * 60 * 1000) // days to milliseconds
    const blockNAgo = Number(blockNow.block.header.height) - (timeDelta / avgBlockTime)

    return +blockNAgo.toFixed(0)
}

function UpdateValsetWeights() {
    if (ENVIRONMENT === ENVS.testnet) {
        UpdateHostChainValSet(chainInfos.persistenceTestnet,
            chainInfos.cosmosTestnet,
            addresses.liquidStakeIBCTestnet,
            LIQUIDSTAKEIBC_ADMIN_TESTNET).then(_ => console.log("Success")).catch(e => console.log(e))
    } else {
        UpdateHostChainValSet(chainInfos.persistence,
            chainInfos.cosmos,
            addresses.liquidStakeIBC,
            LIQUIDSTAKEIBC_ADMIN).then(_ => console.log("Success")).catch(e => console.log(e))
    }
}

UpdateValsetWeights()