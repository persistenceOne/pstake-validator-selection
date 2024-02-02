import {QueryClientImpl as StakingQuery} from "persistenceonejs/cosmos/staking/v1beta1/query.js"
import {QueryClientImpl as SlashingQuery,} from "persistenceonejs/cosmos/slashing/v1beta1/query.js"
import {QueryClientImpl as GovQuery} from "cosmjs-types/cosmos/gov/v1beta1/query.js"
import {QueryClientImpl as GovV1Query} from "cosmjs-types/cosmos/gov/v1/query.js"
import {AllPaginatedQuery, RpcClient, stringifyJson} from "./helper.js";
import {chainInfos, COMETBFT_VERSIONS} from "./constants.js";
import {BondStatus, bondStatusToJSON} from "persistenceonejs/cosmos/staking/v1beta1/staking.js";
import * as fs from "fs";
import {
    CalculateValidatorFinalScore,
    FilterDenyList,
    FilterOnBlocksMissed,
    FilterOnCommission,
    FilterOnGov,
    FilterOnSlashingEvents,
    FilterOnTimeActiveSet,
    FilterOnUptime,
    FilterOnVotingPower,
    UpdateSigningInfosToValidators
} from "./filter.js";

async function GetTestHostChainValSetData(persistenceChainInfo, cosmosChainInfo) {

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
    // if (hostChain.hostChain.flags.lsm === true) {
    //     try {
    //         allVals = await FilterOnValidatorBond(cosmosStakingClient, allVals, cosmosChainInfo.pstakeConfig.validatorBond)
    //     } catch (e) {
    //         throw e
    //     }
    //     console.log("filtered on validators bond")
    // }

    // reject/filter on Gov in last N days, calculate scores, this might fail if rpc gives up ( approx 180 requests )
    try {
        if (cosmosChainInfo.tmVersion === COMETBFT_VERSIONS.comet34) {
            allVals = await FilterOnGov(cosmosGovClient, cosmosTMClient, allVals, cosmosChainInfo.pstakeConfig.gov, cosmosChainInfo.prefix)
        } else {
            allVals = await FilterOnGov(cosmosGovV1Client, cosmosTMClient, allVals, cosmosChainInfo.pstakeConfig.gov, cosmosChainInfo.prefix)
        }    } catch (e) {
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
        let valScore = CalculateValidatorFinalScore(allVals[i], cosmosChainInfo.pstakeConfig, false)
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

    const jsonString = stringifyJson(allVals)
    fs.writeFileSync(cosmosChainInfo.pstakeConfig.filename, jsonString);
    process.stdout.write(jsonString + "\n")
    return
}

// GetTestHostChainValSetData(chainInfos.persistence, chainInfos.osmosis).then(r => console.log("SUCCESS")).catch(e => console.error(e))