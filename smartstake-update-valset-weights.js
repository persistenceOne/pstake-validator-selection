import {QueryClientImpl as PstakeQuery} from "persistenceonejs/pstake/liquidstakeibc/v1beta1/query.js"
import {QueryClientImpl as StakingQuery} from "persistenceonejs/cosmos/staking/v1beta1/query.js"
import {QueryClientImpl as SlashingQuery,} from "persistenceonejs/cosmos/slashing/v1beta1/query.js"
import {AllPaginatedQuery, CreateSigningClientFromAddress, parseJson, RpcClient, stringifyJson} from "./helper.js";
import {addresses, chainInfos, FN, FNS, HOST_CHAIN, HOST_CHAINS, LIQUIDSTAKEIBC_ADMIN} from "./constants.js";
import {assertIsDeliverTxSuccess} from "@cosmjs/stargate";
import {MsgExec} from "cosmjs-types/cosmos/authz/v1beta1/tx.js";
import {MsgUpdateHostChain} from "persistenceonejs/pstake/liquidstakeibc/v1beta1/msgs.js";
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
import {BondStatus, bondStatusToJSON} from "cosmjs-types/cosmos/staking/v1beta1/staking.js";

async function GetHostChainValSetData(persistenceChainInfo, cosmosChainInfo) {
    const [persistenceTMClient, persistenceRpcClient] = await RpcClient(persistenceChainInfo)
    const pstakeQueryClient = new PstakeQuery(persistenceRpcClient)
    let hostChain = await pstakeQueryClient.HostChain({chainId: cosmosChainInfo.chainID})

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

// DUPLICATE FROM stkatom-update-valset-weights
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

async function UpdateValsetWeights() {
    console.log(HOST_CHAIN, FN)
    if (HOST_CHAIN === HOST_CHAINS.cosmos) {
        return await Fn(chainInfos.persistence, chainInfos.cosmos, addresses.liquidStakeIBC, LIQUIDSTAKEIBC_ADMIN)
    } else if (HOST_CHAIN === HOST_CHAINS.osmosis) {
        return await Fn(chainInfos.persistence, chainInfos.osmosis, addresses.liquidStakeIBC, LIQUIDSTAKEIBC_ADMIN)
    } else if (HOST_CHAIN === HOST_CHAINS.dydx) {
        return await Fn(chainInfos.persistence, chainInfos.dydx, addresses.liquidStakeIBC, LIQUIDSTAKEIBC_ADMIN)
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