import dotenv from "dotenv"
import {stringToPath} from "@cosmjs/crypto/build/slip10.js";
import {GasPrice} from "@cosmjs/stargate";

dotenv.config()
export const ENVS = {testnet: "TESTNET", mainnet: "MAINNET"}
export const MNEMONIC = process.env.MNEMONIC
export const ENVIRONMENT = process.env.ENVIRONMENT || ENVS.mainnet
export const LIQUIDSTAKEIBC_ADMIN = "persistence1ealyadcds02yvsn78he4wntt7tpdqhlhg7y2s6"
export const LIQUIDSTAKEIBC_ADMIN_TESTNET = "persistence18dsfsljczehwd5yem9qq2jcz56dz3shp48j3zj"
export const chainInfos = {
    persistence: {
        rpc: "https://rpc.core.persistence.one:443",
        chainID: "core-1",
        prefix: "persistence",
        feeDenom: "uxprt",
        gasPrice: GasPrice.fromString("0.005uxprt")
    },
    cosmos: {
        rpc: "https://rpc.cosmos.audit.one:443",
        chainID: "cosmoshub-4",
        prefix: "cosmos",
        feeDenom: "uatom",
        gasPrice: GasPrice.fromString("0.005uatom")
    },

    // TESTNETS
    persistenceTestnet: {
        rpc: "https://rpc.testnet2.persistence.one:443",
        chainID: "test-core-2",
        prefix: "persistence",
        feeDenom: "uxprt",
        gasPrice: GasPrice.fromString("0.005uxprt")
    },
    cosmosTestnet: {
        rpc: "http://rpc.sentry-02.theta-testnet.polypore.xyz:26657",
        chainID: "theta-testnet-001",
        prefix: "cosmos",
        feeDenom: "uatom",
        gasPrice: GasPrice.fromString("0.005uatom")
    },
}
export const addresses = {
    liquidStakeIBC: {
        address: "persistence1wmd9kfszmzymug76hjfjrfyghzmts6gcls763g",
        hdPath: stringToPath("m/44'/118'/2'/0/0"),
        prefix: "persistence",
        chainInfo: chainInfos.persistence,
        description: "Has authz for updating HostChains of liquidstakeibc module, granter: persistence1ealyadcds02yvsn78he4wntt7tpdqhlhg7y2s6, older granter: persistence12d7ett36q9vmtzztudt48f9rtyxlayflz5gun3"
    },

    //TESTNETS
    liquidStakeIBCTestnet: {
        address: "persistence1h69039p8dpjlrx3uwz656rhmdcmnd8tyx5y6fe",
        hdPath: stringToPath("m/44'/0'/1'/0/0"),
        prefix: "persistence",
        chainInfo: chainInfos.persistenceTestnet,
        description: "Has authz for updating HostChains/ UpdateParams of liquidstakeibc module, has authz for persistence18dsfsljczehwd5yem9qq2jcz56dz3shp48j3zj"
    },
}