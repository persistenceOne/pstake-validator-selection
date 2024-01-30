import {QueryClientImpl as PstakeQuery} from "persistenceonejs/pstake/liquidstakeibc/v1beta1/query.js"
import {QueryClientImpl as StakingQuery} from "persistenceonejs/cosmos/staking/v1beta1/query.js"
import {QueryClientImpl as SlashingQuery,} from "persistenceonejs/cosmos/slashing/v1beta1/query.js"
import {QueryClientImpl as PstakeXprtQuery} from "persistenceonejs/pstake/liquidstake/v1beta1/query.js"
import {MsgUpdateParams} from "persistenceonejs/pstake/liquidstake/v1beta1/tx.js";
import {BondStatus, bondStatusToJSON} from "cosmjs-types/cosmos/staking/v1beta1/staking.js";
import {AllPaginatedQuery, CreateSigningClientFromAddress, parseJson, RpcClient, stringifyJson} from "./helper.js";
import {addresses, chainInfos, FN, FNS, GOV_MODULE_ADDRESS, HOST_CHAIN, HOST_CHAINS} from "./constants.js";
import {assertIsDeliverTxSuccess, coins} from "@cosmjs/stargate";
import * as fs from "fs";
import {
    CalculateValidatorFinalScore,
    FilterDenyList,
    FilterOnBlocksMissed,
    FilterOnCommission,
    FilterOnSlashingEvents,
    FilterOnTimeActiveSet,
    FilterOnValidatorBond,
    FilterOnVotingPower,
    SmartStakeFilterOnGov,
    SmartStakeFilterOnUptime,
    UpdateSigningInfosToValidators
} from "./filter.js";

async function GetHostChainValSetData(persistenceChainInfo, cosmosChainInfo) {
    const [persistenceTMClient, persistenceRpcClient] = await RpcClient(persistenceChainInfo)
    const pstakeQueryClient = new PstakeQuery(persistenceRpcClient)
    let hostChain = await pstakeQueryClient.HostChain({chainId: cosmosChainInfo.chainID})
    const lsm = true

    const [cosmosTMClient, cosmosRpcClient] = await RpcClient(cosmosChainInfo)
    const cosmosStakingClient = new StakingQuery(cosmosRpcClient)
    const cosmosSlashingClient = new SlashingQuery(cosmosRpcClient)

    let appName = cosmosChainInfo.pstakeConfig.smartStakeApiAppName
    if (appName === "") {
        throw new Error("appName not found for chain-id " + cosmosChainInfo.chainID)
    }
    // // query all bonded vals
    let allValsBonded = await AllPaginatedQuery(cosmosStakingClient.Validators, {status: bondStatusToJSON(BondStatus.BOND_STATUS_BONDED)}, "validators")

    // put it into struct that has all info
    let allVals = []
    for (let validator of allValsBonded) {
        let valmap = {
            valoper: validator.operatorAddress,
            validator: validator,
            deny: false,
            denyReason: [],
            commissionScore: 0,
            uptimeScore: 0,
            govScore: 0,
            votingPowerScore: 0,
            validatorBondScore: 0,
            overAllValidatorScore: 0,
            weight: 0,
            moniker: validator.name,
        }
        allVals.push(valmap)

    }
    console.log(allVals.length)
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
    if (lsm) {
        try {
            allVals = await FilterOnValidatorBond(cosmosStakingClient, allVals, cosmosChainInfo.pstakeConfig.validatorBond)
        } catch (e) {
            throw e
        }
        console.log("filtered on validators bond")
    }

    // reject/filter on Gov in last N days, calculate scores, this might fail if rpc gives up ( approx 180 requests )
    try {
        allVals = await SmartStakeFilterOnGov(appName, allVals, cosmosChainInfo.pstakeConfig.gov, cosmosChainInfo.prefix)
    } catch (e) {
        throw e
    }
    console.log("filtered on gov")

    // reject/filter on uptime, calculate scores, this might fail if rpc gives up (approx 180 * Ndays requests )
    try {
        allVals = await SmartStakeFilterOnUptime(appName, allVals, cosmosChainInfo.pstakeConfig.uptime)
        console.log("filtered on uptime")
    } catch (e) {
        // most likely to fail, just score them all 100 if this is the case.
        for (let i = 0; i < allVals.length; i++) {
            allVals[i].uptimeScore = 100
        }
        console.log("Failed to filter on uptime, so awarded 100%, err:", e)
    }

    for (let i = 0; i < allVals.length; i++) {
        let valScore = CalculateValidatorFinalScore(allVals[i], cosmosChainInfo.pstakeConfig, lsm)
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
    const pstakeQueryClient = new PstakeXprtQuery(persistenceRpcClient)
    let hostChainParams = await pstakeQueryClient.Params()

    let allVals = parseJson(fs.readFileSync(cosmosChainInfo.pstakeConfig.filename))

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
    let kvUpdates = []
    for (let i = 0; i < nonZeroVals.length; i++) {
        // to scratch float approximations
        if (i === nonZeroVals.length - 1) {
            nonZeroVals[i].weight = 1 - sum
        }
        sum = sum + nonZeroVals[i].weight
        kvUpdates.push({
            validatorAddress: nonZeroVals[i].valoper, targetWeight: nonZeroVals[i].weight.toString()
        })
    }

    let newHostChainParams = hostChainParams.params
    newHostChainParams.whitelistedValidators = kvUpdates

    if (kvUpdates.length <= 0) {
        console.log("no kv updates, total kv updates:", kvUpdates.length)
        return
    } else {
        console.log("total kv updates:", kvUpdates.length)
    }
    const msgUpdateHostChainParams = {
        typeUrl: "/pstake.liquidstake.v1beta1.MsgUpdateParams", value: MsgUpdateParams.fromPartial({
            authority: AuthzGranterAddr, params: newHostChainParams
        })
    }
    console.log(JSON.stringify(msgUpdateHostChainParams))

    const msg = {
        typeUrl: "/cosmos.gov.v1.MsgSubmitProposal", value: MsgSubmitProposal.fromPartial({
            proposer: granteePersistenceAddr.address,
            messages: [{
                typeUrl: msgUpdateHostChainParams.typeUrl,
                value: MsgUpdateParams.encode(msgUpdateHostChainParams.value).finish()
            }],
            initialDeposit: coins(512000000, persistenceChainInfo.feeDenom),
            metadata: "",
            title: "Auto update stkxprt validator list in Params",
            summary: "Runs output of Pstake validator selections from github actions."
        })
    }
    console.log("msg: ", JSON.stringify(msg))

    const signingPersistenceClient = await CreateSigningClientFromAddress(granteePersistenceAddr)
    const response = await signingPersistenceClient.signAndBroadcast(granteePersistenceAddr.address, [msg], 1.5, "Auto validator update check")
    console.log(JSON.stringify(response))
    assertIsDeliverTxSuccess(response)
}

async function UpdateValsetWeights() {
    console.log(HOST_CHAIN, FN)
    if (HOST_CHAIN === HOST_CHAINS.persistence) {
        return await Fn(chainInfos.persistence, chainInfos.persistence, addresses.liquidStakeIBC, GOV_MODULE_ADDRESS)
    }
}

async function Fn(controllerChainInfo, hostChainInfo, txnSenderAddress, adminAddress) {
    if (FN === FNS.getData) {
        return await GetHostChainValSetData(controllerChainInfo, hostChainInfo)
    } else if (FN === FNS.doTx) {
        return await TxUpdateValsetWeights(controllerChainInfo, hostChainInfo, txnSenderAddress, adminAddress)
    }
}

UpdateValsetWeights().then(_ => console.log("Success"))