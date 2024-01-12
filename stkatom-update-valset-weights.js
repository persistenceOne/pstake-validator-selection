import {QueryClientImpl as PstakeQuery} from "persistenceonejs/pstake/liquidstakeibc/v1beta1/query.js"
import {QueryClientImpl as StakingQuery} from "persistenceonejs/cosmos/staking/v1beta1/query.js"
import {
    QueryClientImpl as SlashingQuery,
    QuerySigningInfoRequest,
    QuerySigningInfoResponse,
} from "persistenceonejs/cosmos/slashing/v1beta1/query.js"
import {QueryClientImpl as GovQuery} from "cosmjs-types/cosmos/gov/v1beta1/query.js"
import {QueryClientImpl as GovV1Query} from "cosmjs-types/cosmos/gov/v1/query.js"
import {
    AllPaginatedQuery,
    ChangeAddressPrefix,
    CreateSigningClientFromAddress,
    CustomRegistry,
    parseJson,
    RpcClient,
    stringifyJson,
    txSearchParams,
    ValidatorPubkeyToBech32
} from "./helper.js";
import {
    addresses,
    chainInfos,
    COMETBFT_VERSIONS,
    FN,
    FNS,
    HOST_CHAIN,
    HOST_CHAINS,
    LIQUIDSTAKEIBC_ADMIN,
    LIQUIDSTAKEIBC_ADMIN_TESTNET
} from "./constants.js";
import {assertIsDeliverTxSuccess, decodeCosmosSdkDecFromProto, QueryClient} from "@cosmjs/stargate";
import {MsgExec} from "cosmjs-types/cosmos/authz/v1beta1/tx.js";
import {MsgUpdateHostChain} from "persistenceonejs/pstake/liquidstakeibc/v1beta1/msgs.js";
import {BondStatus, bondStatusToJSON} from "persistenceonejs/cosmos/staking/v1beta1/staking.js";
import {Decimal} from "@cosmjs/math";
import {ProposalStatus} from "cosmjs-types/cosmos/gov/v1beta1/gov.js";
import {fromTimestamp} from "cosmjs-types/helpers.js";
import * as fs from "fs";
import * as proto from "@cosmjs/proto-signing";

async function GetHostChainValSetData(persistenceChainInfo, cosmosChainInfo) {
    const [persistenceTMClient, persistenceRpcClient] = await RpcClient(persistenceChainInfo)
    const pstakeQueryClient = new PstakeQuery(persistenceRpcClient)
    let hostChain = await pstakeQueryClient.HostChain({chainId: cosmosChainInfo.chainID})

    const [cosmosTMClient, cosmosRpcClient] = await RpcClient(cosmosChainInfo)
    const cosmosStakingClient = new StakingQuery(cosmosRpcClient)
    const cosmosGovClient = new GovQuery(cosmosRpcClient)
    const cosmosGovV1Client = new GovV1Query(cosmosRpcClient)
    const cosmosSlashingClient = new SlashingQuery(cosmosRpcClient)

    // query all bonded vals
    let allValsBonded = await AllPaginatedQuery(cosmosStakingClient.Validators, {status: bondStatusToJSON(BondStatus.BOND_STATUS_BONDED)}, "validators")

    // put it into struct that has all info
    let allVals = []
    for (let validator of allValsBonded) {
        let valmap = {
            valoper: validator.operatorAddress,
            validator: validator,
            signingInfo: {},
            proposalsVoted: [],
            deny: false,
            denyReason: [],
            commissionScore: 0,
            uptimeScore: 0,
            govScore: 0,
            votingPowerScore: 0,
            validatorBondScore: 0,
            overAllValidatorScore: 0,
            weight: 0,
            moniker: validator.description.moniker,
        }
        allVals.push(valmap)
    }
    console.log("update all validators")

    allVals = await UpdateSigningInfosToValidators(cosmosSlashingClient, allVals, cosmosChainInfo.pstakeConfig.valconsPrefix)
    console.log("update validator-infos")

    // Reject vals based on deny list
    try {
        allVals = FilterDenyList(allVals, cosmosChainInfo.pstakeConfig.denyListVals)
    } catch (e) {
        throw e
    }
    console.log("filtered denylist")

    // reject/filter on commission, calculate scores
    try {
        allVals = FilterOnCommission(allVals, cosmosChainInfo.pstakeConfig.commission)
    } catch (e) {
        throw e
    }
    console.log("filtered commission")

    // reject/filter on voting power, calculate scores
    try {
        allVals = FilterOnVotingPower(allVals, cosmosChainInfo.pstakeConfig.votingPower)
    } catch (e) {
        throw e
    }
    console.log("filtered voting power")

    // reject/filter on blocks missed in signed_blocks_window
    try {
        allVals = FilterOnBlocksMissed(cosmosSlashingClient, allVals, cosmosChainInfo.pstakeConfig.blocksMissed)
    } catch (e) {
        throw e
    }
    console.log("filtered on blocks missed")

    // reject/filter time in active set, calculate scores
    try {
        allVals = await FilterOnTimeActiveSet(cosmosTMClient, allVals, cosmosChainInfo.pstakeConfig.timeInActiveSet)
    } catch (e) {
        throw e
    }
    console.log("filtered on time in active set")

    // reject/ filter on slashing events, calculate scores
    try {
        allVals = await FilterOnSlashingEvents(cosmosTMClient, allVals, cosmosChainInfo.pstakeConfig.slashingEvents)
    } catch (e) {
        throw e
    }
    console.log("filtered on slashing events")

    // reject/ filter on validator bond, calculate scores
    if (hostChain.hostChain.flags.lsm === true) {
        try {
            allVals = await FilterOnValidatorBond(cosmosStakingClient, allVals, cosmosChainInfo.pstakeConfig.validatorBond)
        } catch (e) {
            throw e
        }
        console.log("filtered on validators bond")
    }

    // reject/filter on Gov in last N days, calculate scores, this might fail if rpc gives up ( approx 180 requests )
    try {
        if (cosmosChainInfo.tmVersion === COMETBFT_VERSIONS.comet34) {
            allVals = await FilterOnGov(cosmosGovClient, cosmosTMClient, allVals, cosmosChainInfo.pstakeConfig.gov, cosmosChainInfo.prefix)
        } else {
            allVals = await FilterOnGov(cosmosGovV1Client, cosmosTMClient, allVals, cosmosChainInfo.pstakeConfig.gov, cosmosChainInfo.prefix)
        }
    } catch (e) {
        throw e
    }
    console.log("filtered on gov")

    // reject/filter on uptime, calculate scores, this might fail if rpc gives up (approx 180 * Ndays requests )
    try {
        allVals = await FilterOnUptime(cosmosTMClient, allVals, cosmosChainInfo.pstakeConfig.uptime, cosmosChainInfo.pstakeConfig.valconsPrefix)
        console.log("filtered on uptime")
    } catch (e) {
        // most likely to fail, just score them all 100 if this is the case.
        for (let i = 0; i < allVals.length; i++) {
            allVals[i].uptimeScore = 100
        }
        console.log("Failed to filter on uptime, so awarded 100%, err:", e)
    }

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
        allVals[i].weight = +(allVals[i].overAllValidatorScore / totalDenom).toFixed(10)
    }

    const jsonString = stringifyJson(allVals)
    fs.writeFileSync(cosmosChainInfo.pstakeConfig.filename, jsonString);
    process.stdout.write(jsonString + "\n")
    return
}

async function TxUpdateValsetWeights(persistenceChainInfo, cosmosChainInfo, granteePersistenceAddr, AuthzGranterAddr) {
    const [persistenceTMClient, persistenceRpcClient] = await RpcClient(persistenceChainInfo)
    const pstakeQueryClient = new PstakeQuery(persistenceRpcClient)
    let hostChain = await pstakeQueryClient.HostChain({chainId: cosmosChainInfo.chainID})

    let allVals = parseJson(fs.readFileSync(cosmosChainInfo.pstakeConfig.filename))

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
            key: "add_validator", value: JSON.stringify({
                operator_address: add_vals[i],
                status: "BOND_STATUS_UNSPECIFIED",
                weight: "0",
                delegated_amount: "0",
                exchange_rate: "1",
                delegable: !hostChain.hostChain.flags.lsm
            })
        })
        kvUpdates.push({
            key: "validator_update", value: add_vals[i]
        })
    }
    // reset weights to zero
    for (let i = 0; i < hostChain.hostChain.validators.length; i++) {
        kvUpdates.push({
            key: "validator_weight", value: `${hostChain.hostChain.validators[i].operatorAddress},0`
        })
    }

    // add kv updates to set weight
    let nonZeroVals = []
    for (let i = 0; i < allVals.length; i++) {
        if (allVals[i].deny === true) {
            continue
        }
        nonZeroVals.push({
            valoper: allVals[i].valoper,
            weight: allVals[i].weight
        })
    }
    // add to check if sum of weights is 1.
    let sum = 0
    for (let i = 0; i < nonZeroVals.length; i++) {
        // to scratch float approximations
        if (i === nonZeroVals.length - 1) {
            nonZeroVals[i].weight = 1 - sum
        }
        sum = sum + nonZeroVals[i].weight
        kvUpdates.push({
            key: "validator_weight", value: `${nonZeroVals[i].valoper},${nonZeroVals[i].weight}`
        })
    }

    if (kvUpdates.length <= hostChain.hostChain.validators.length) {
        console.log("no kv updates, total kv updates:", kvUpdates.length)
        return
    } else {
        console.log("total kv updates:", kvUpdates.length)
    }
    const msgUpdateHostChain = {
        typeUrl: "/pstake.liquidstakeibc.v1beta1.MsgUpdateHostChain", value: MsgUpdateHostChain.fromPartial({
            authority: AuthzGranterAddr, chainId: cosmosChainInfo.chainID, updates: kvUpdates
        })
    }
    console.log(JSON.stringify(msgUpdateHostChain))

    const msg = {
        typeUrl: "/cosmos.authz.v1beta1.MsgExec", value: MsgExec.fromPartial({
            grantee: granteePersistenceAddr.address, msgs: [{
                typeUrl: msgUpdateHostChain.typeUrl, value: MsgUpdateHostChain.encode(msgUpdateHostChain.value).finish()
            }]
        })
    }
    console.log("msg: ", JSON.stringify(msg))

    const signingPersistenceClient = await CreateSigningClientFromAddress(granteePersistenceAddr)
    const response = await signingPersistenceClient.signAndBroadcast(granteePersistenceAddr.address, [msg], 1.5, "Auto validator update check")
    console.log(JSON.stringify(response))
    assertIsDeliverTxSuccess(response)
}

export function FilterDenyList(validators, denylist, reason = {name: "denylist", description: "Is part of deny list"}) {
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

export function FilterOnCommission(validators, commissionConfig, reason = {name: "commission", description: ""}) {
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

export async function FilterOnUptime(tmClient, validators, uptimeConfig, valconsPrefix, reason = {
    name: "uptime",
    description: ""
}) {
    for (let i = 0; i < validators.length; i++) {
        let [blockAgo, currentBlock] = await BlockNDaysAgo(tmClient, uptimeConfig.lastNDays)
        let blocksMissed = 0
        let maxBlocksCounted = 0
        for (let block = currentBlock; block > blockAgo;) {
            let uptime = await QuerySigningInfosAtHeight(tmClient, validators[i], valconsPrefix, blockAgo)

            blocksMissed = blocksMissed + Number(uptime.valSigningInfo.missedBlocksCounter)
            maxBlocksCounted = maxBlocksCounted + uptimeConfig.blocksWindow
            block = block - uptimeConfig.blocksWindow
        }
        let valUptime = 1 - (blocksMissed / maxBlocksCounted)

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

export async function FilterOnGov(govQueryClient, tmClient, validators, govConfig, hostChainPrefix, reason = {
    name: "governance participation", description: ""
}) {
    let proposals = await AllPaginatedQuery(govQueryClient.Proposals, {
        proposalStatus: ProposalStatus.PROPOSAL_STATUS_UNSPECIFIED, voter: "", depositor: ""
    }, "proposals")
    let timeNow = new Date(Date.now())
    let timeDelta = new Date().setTime(govConfig.lastNDays * 24 * 60 * 60 * 1000) // days to milliseconds

    let totalCompleteProposals = []
    for (let i = 0; i < proposals.length; i++) {
        if (proposals[i].status === ProposalStatus.PROPOSAL_STATUS_VOTING_PERIOD ||
            proposals[i].status === ProposalStatus.PROPOSAL_STATUS_DEPOSIT_PERIOD) {
            continue
        }
        let proposalID = proposals[i].proposalId !== undefined ? proposals[i].proposalId.toNumber() : proposals[i].id.toNumber()
        let votingEndTime = fromTimestamp(proposals[i].votingEndTime)
        let diff = timeNow - votingEndTime
        if (diff < timeDelta) {
            totalCompleteProposals.push(proposalID)
        }
    }

    // TODO async this
    for (let i = 0; i < validators.length; i++) {

        let voterAddr = ChangeAddressPrefix(validators[i].valoper, hostChainPrefix)
        let gov_pages = govConfig.maxTxPage
        let per_page = 100
        validators[i].proposalsVoted = []

        for (let page = 1; page <= gov_pages; page++) {
            let tags = [
                // {key: "message.action", value: "/cosmos.gov.v1beta1.MsgVote"},
                {key: "message.module", value: "governance"},
                {key: "message.sender", value: voterAddr},
            ]
            let results = await tmClient.txSearch(txSearchParams(tags, page, per_page))
            for (let transaction of results.txs) {
                const decodedTransaction = proto.decodeTxRaw(transaction.tx);
                if (transaction.result.code === 0) {
                    for (let message of decodedTransaction.body.messages) {
                        if (message.typeUrl === "/cosmos.gov.v1beta1.MsgVote" ||
                            message.typeUrl === "/cosmos.gov.v1beta1.MsgVoteWeighted" ||
                            message.typeUrl === "/cosmos.gov.v1.MsgVote" ||
                            message.typeUrl === "/cosmos.gov.v1.MsgVoteWeighted") {
                            const body = CustomRegistry.decode(message);
                            let proposalID = Number(body.proposalId)
                            if (totalCompleteProposals.includes(proposalID) && !validators[i].proposalsVoted.includes(proposalID)) {
                                validators[i].proposalsVoted.push(proposalID)
                            }
                        }
                    }
                }
            }
            if (results.totalCount < per_page * (page)) {
                break
            }

        }
        for (let page = 1; page <= gov_pages; page++) {
            let authzTags = [
                {key: "message.action", value: "/cosmos.authz.v1beta1.MsgExec"},
                {key: "message.sender", value: voterAddr},
                {key: "message.module", value: "governance"},
            ]

            let authzResults = await tmClient.txSearch(txSearchParams(authzTags, page, per_page))
            for (let transaction of authzResults.txs) {
                const decodedTransaction = proto.decodeTxRaw(transaction.tx);
                if (transaction.result.code === 0) {
                    for (let message of decodedTransaction.body.messages) {
                        if (message.typeUrl === "/cosmos.authz.v1beta1.MsgExec") {
                            const body = CustomRegistry.decode(message);
                            for (let authzmsg of body.msgs) {
                                // shall not go recursive, no ica msgVotes allowed
                                if (authzmsg.typeUrl === "/cosmos.gov.v1beta1.MsgVote" ||
                                    authzmsg.typeUrl === "/cosmos.gov.v1beta1.MsgVoteWeighted" ||
                                    message.typeUrl === "/cosmos.gov.v1.MsgVote" ||
                                    message.typeUrl === "/cosmos.gov.v1.MsgVoteWeighted") {
                                    const msgBody = CustomRegistry.decode(authzmsg);
                                    let proposalID = Number(msgBody.proposalId)
                                    if (totalCompleteProposals.includes(proposalID) && !validators[i].proposalsVoted.includes(proposalID)) {
                                        validators[i].proposalsVoted.push(proposalID)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if (authzResults.totalCount < per_page * (page)) {
                break
            }
        }
    }
    // ideally should be equal to totalCompleteProposals, but since archival node might not have all data.
    // we choose max by any validator and take % out of it
    // let maxVoted = totalCompleteProposals.length
    let maxVoted = 0
    for (let i = 0; i < validators.length; i++) {
        if (validators[i].proposalsVoted.length > maxVoted) {
            maxVoted = validators[i].proposalsVoted.length
        }
    }
    for (let i = 0; i < validators.length; i++) {
        let percentVoted = validators[i].proposalsVoted.length / maxVoted
        if (maxVoted === 0) {
            // handle 0 totalcountproposals case, if no gov proposals
            validators[i].govScore = 100
        } else {
            if (percentVoted < govConfig.min) {
                validators[i].deny = true
                let submitReason = {}
                submitReason.name = reason.name
                submitReason.description = `Required between ${govConfig.min} and ${govConfig.max} , found ${percentVoted} `
                validators[i].denyReason.push(submitReason)
            } else {
                //calculate score
                validators[i].govScore = CalculateScore(percentVoted, govConfig.min, govConfig.max, govConfig.min)
            }
        }
    }
    return validators
}

export function FilterOnVotingPower(validators, votingPowerConfig, reason = {name: "VotingPower", description: ""}) {
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

export function FilterOnBlocksMissed(cosmosSlashingClient, validators, blockmissedConfig, reason = {
    name: "blocks missed in sign_window", description: ""
}) {

    for (let i = 0; i < validators.length; i++) {
        let blocksMissed = Number(validators[i].signingInfo.missedBlocksCounter)
        if (blocksMissed > blockmissedConfig.max) {
            validators[i].deny = true
            let submitReason = {}
            submitReason.name = reason.name
            submitReason.description = `Required between ${blockmissedConfig.min} and ${blockmissedConfig.max} , found ${blocksMissed} `
            validators[i].denyReason.push(submitReason)
        }
    }
    return validators
}

// same as slashing.
export async function FilterOnTimeActiveSet(cosmosTMClient, validators, timeActiveSetConfig, reason = {
    name: "Time in ActiveSet", description: ""
}) {
    let [blockHeightBeforeNDays, currentBlock] = await BlockNDaysAgo(cosmosTMClient, timeActiveSetConfig.lastNDays)
    for (let i = 0; i < validators.length; i++) {
        let startHeight = Number(validators[i].signingInfo.startHeight)
        if (startHeight > blockHeightBeforeNDays || validators[i].validator.jailed === true) {
            validators[i].deny = true
            let submitReason = {}
            submitReason.name = reason.name
            submitReason.description = `Required less than ${blockHeightBeforeNDays} , found ${startHeight} `
            validators[i].denyReason.push(submitReason)
        }
    }
    return validators
}

// only finds if validator has been slashed in past N days, not the number of slashes.
export async function FilterOnSlashingEvents(cosmosTMClient, validators, slashingConfig, reason = {
    name: "Slashing", description: ""
}) {
    let [blockHeightBeforeNDays, currentBlock] = await BlockNDaysAgo(cosmosTMClient, slashingConfig.lastNDays)
    for (let i = 0; i < validators.length; i++) {
        let startHeight = Number(validators[i].signingInfo.startHeight)
        if (startHeight > blockHeightBeforeNDays || validators[i].validator.jailed === true) {
            validators[i].deny = true
            let submitReason = {}
            submitReason.name = reason.name
            submitReason.description = `Required less than ${blockHeightBeforeNDays} , found ${startHeight} `
            validators[i].denyReason.push(submitReason)
        }
    }
    return validators
}

export async function FilterOnValidatorBond(stakingClient, validators, validatorBondConfig, reason = {
    name: "validator bond", description: ""
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

export function CalculateScore(val, revOptimal, max, min, normalizationFactor = 100) {
    return +(Math.abs(val - revOptimal) * normalizationFactor / Math.abs(max - min)).toFixed(2)
}

export function CalculateValidatorFinalScore(validator, config, lsmFlag) {

    let numerator = (validator.commissionScore * config.commission.weight) + (validator.uptimeScore * config.uptime.weight) + (validator.govScore * config.gov.weight) + (validator.votingPowerScore * config.votingPower.weight)
    if (lsmFlag) {
        numerator = numerator + (validator.validatorBondScore * config.validatorBond.weight)
    }
    let denominator = config.commission.weight + config.uptime.weight + config.gov.weight + config.votingPower.weight
    if (lsmFlag) {
        denominator = denominator + config.validatorBond.weight
    }
    denominator = denominator * 100

    return +(numerator / denominator)
}

export async function UpdateSigningInfosToValidators(cosmosSlashingClient, validators, valconsPrefix) {
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

export async function QuerySigningInfosAtHeight(tmQueryClient, validator, valconsPrefix, height) {
    let validatorConsAddr = ValidatorPubkeyToBech32(validator.validator.consensusPubkey, valconsPrefix)

    const queryClient = await QueryClient.withExtensions(tmQueryClient)
    const requestData = QuerySigningInfoRequest.encode({consAddress: validatorConsAddr}).finish();
    const data = await queryClient.queryAbci(`/cosmos.slashing.v1beta1.Query/SigningInfo`, requestData);
    const response = QuerySigningInfoResponse.decode(data.value);
    return response
}


// Not the most accurate, might be even less during upgrades
export async function BlockNDaysAgo(queryClient, N) {
    const blockNow = await queryClient.block()
    const factor = 10000
    const blockOld = await queryClient.block(Number(blockNow.block.header.height) - factor)

    const timeNow = new Date(blockNow.block.header.time)
    const timeFactorAgo = new Date(blockOld.block.header.time)

    const avgBlockTime = (timeNow.getTime() - timeFactorAgo.getTime()) / factor

    const timeDelta = new Date().setTime(N * 24 * 60 * 60 * 1000) // days to milliseconds
    const blockNAgo = Number(blockNow.block.header.height) - (timeDelta / avgBlockTime)

    return [+blockNAgo.toFixed(0), blockNow.block.header.height]
}

async function UpdateValsetWeights() {
    console.log(HOST_CHAIN, FN)
    if (HOST_CHAIN === HOST_CHAINS.cosmosTestnet) {
        return await Fn(chainInfos.persistenceTestnet, chainInfos.cosmosTestnet, addresses.liquidStakeIBCTestnet, LIQUIDSTAKEIBC_ADMIN_TESTNET)
    } else if (HOST_CHAIN === HOST_CHAINS.osmosisTestnet) {
        return await Fn(chainInfos.persistenceTestnet, chainInfos.osmosisTestnet, addresses.liquidStakeIBCTestnet, LIQUIDSTAKEIBC_ADMIN_TESTNET)
    } else if (HOST_CHAIN === HOST_CHAINS.cosmos) {
        return await Fn(chainInfos.persistence, chainInfos.cosmos, addresses.liquidStakeIBC, LIQUIDSTAKEIBC_ADMIN)
    } else if (HOST_CHAIN === HOST_CHAINS.osmosis) {
        return await Fn(chainInfos.persistence, chainInfos.osmosis, addresses.liquidStakeIBC, LIQUIDSTAKEIBC_ADMIN)
    } else if (HOST_CHAIN === HOST_CHAINS.dydx) {
        return await Fn(chainInfos.persistence, chainInfos.dydx, addresses.liquidStakeIBC, LIQUIDSTAKEIBC_ADMIN)
    }
    // add more chain running on tm v34.
}

async function Fn(controllerChainInfo, hostChainInfo, txnSenderAddress, adminAddress) {
    if (FN === FNS.getData) {
        return await GetHostChainValSetData(controllerChainInfo, hostChainInfo)
    } else if (FN === FNS.doTx) {
        return await TxUpdateValsetWeights(controllerChainInfo, hostChainInfo, txnSenderAddress, adminAddress)
    }
}

UpdateValsetWeights().then(_ => console.log("Success"))