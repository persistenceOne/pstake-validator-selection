
import {
    addresses,
    chainInfos,
    ENVIRONMENT,
    ENVS,
    LIQUIDSTAKEIBC_ADMIN,
    LIQUIDSTAKEIBC_ADMIN_TESTNET
} from "./constants.ts";
import {UpdateHostChainValSetTypes} from "./types.ts";


async function UpdateHostChainValSet({persistenceChainInfo, cosmosChainInfo, granteePersistenceAddr, AuthzGranterAddr}:UpdateHostChainValSetTypes) {
console.log(persistenceChainInfo, "param")
}

function UpdateValsetWeights() {
    if (ENVIRONMENT === ENVS.testnet) {
        UpdateHostChainValSet({
            persistenceChainInfo: chainInfos.persistenceTestnet,
            cosmosChainInfo: chainInfos.cosmosTestnet,
            granteePersistenceAddr: addresses.liquidStakeIBCTestnet,
            AuthzGranterAddr: LIQUIDSTAKEIBC_ADMIN_TESTNET}).then(_ => console.log("Success"))
    } else {
        UpdateHostChainValSet({
            persistenceChainInfo:chainInfos.persistence,
            cosmosChainInfo: chainInfos.cosmos,
            granteePersistenceAddr: addresses.liquidStakeIBC,
            AuthzGranterAddr: LIQUIDSTAKEIBC_ADMIN
        }).then(_ => console.log("Success"))
    }
}

UpdateValsetWeights()