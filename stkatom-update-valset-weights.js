
import {
    addresses,
    chainInfos,
    ENVIRONMENT,
    ENVS,
    LIQUIDSTAKEIBC_ADMIN,
    LIQUIDSTAKEIBC_ADMIN_TESTNET
} from "./constants.js";

async function UpdateHostChainValSet(persistenceChainInfo, cosmosChainInfo, granteePersistenceAddr, AuthzGranterAddr) {

}

function UpdateValsetWeights() {
    if (ENVIRONMENT === ENVS.testnet) {
        UpdateHostChainValSet(chainInfos.persistenceTestnet,
            chainInfos.cosmosTestnet,
            addresses.liquidStakeIBCTestnet,
            LIQUIDSTAKEIBC_ADMIN_TESTNET).then(_ => console.log("Success"))
    } else {
        UpdateHostChainValSet(chainInfos.persistence,
            chainInfos.cosmos,
            addresses.liquidStakeIBC,
            LIQUIDSTAKEIBC_ADMIN).then(_ => console.log("Success"))
    }
}

UpdateValsetWeights()