import dotenv from "dotenv"
import {stringToPath} from "@cosmjs/crypto/build/slip10.js";
import {GasPrice} from "@cosmjs/stargate";

dotenv.config()
export const ENVS = {testnet: "TESTNET", mainnet: "MAINNET"}
export const MNEMONIC = process.env.MNEMONIC
export const ENVIRONMENT = process.env.ENVIRONMENT || ENVS.mainnet
export const LIQUIDSTAKEIBC_ADMIN = "persistence1ealyadcds02yvsn78he4wntt7tpdqhlhg7y2s6"
export const LIQUIDSTAKEIBC_ADMIN_TESTNET = "persistence18dsfsljczehwd5yem9qq2jcz56dz3shp48j3zj"

export const pstakeHostValsetConfigs = {
    cosmos: {
        valconsPrefix: "cosmosvalcons",
        denyListVals: [
            {name: "Binance Node", valAddr: "cosmosvaloper18ruzecmqj9pv8ac0gvkgryuc7u004te9rh7w5s"},
            {name: "Binance Staking", valAddr: "cosmosvaloper156gqf9837u7d4c4678yt3rl4ls9c5vuursrrzf"},
            {name: "Coinbase Cloud", valAddr: "cosmosvaloper1crqm3598z6qmyn2kkcl9dz7uqs4qdqnr6s8jdn"},
            {name: "Coinbase Custody", valAddr: "cosmosvaloper1c4k24jzduc365kywrsvf5ujz4ya6mwympnc4en"},
            {name: "Kraken", valAddr: "cosmosvaloper1z8zjv3lntpwxua0rtpvgrcwl0nm0tltgpgs6l7"},
            {name: "Upbit Staking", valAddr: "cosmosvaloper1x8efhljzvs52u5xa6m7crcwes7v9u0nlwdgw30"},
            {name: "CoinoneNode", valAddr: "cosmosvaloper1te8nxpc2myjfrhaty0dnzdhs5ahdh5agzuym9v"},
            {name: "Huobi", valAddr: "cosmosvaloper1kn3wugetjuy4zetlq6wadchfhvu3x740ae6z6x"},
            // {name: "", valAddr: ""},
        ],
        commission: {
            min: 0.05,
            max: 0.1,
            weight: 0.25
        },
        uptime: {
            min: 0.95,
            max: 1,
            weight: 0.15
        },
        gov: {
            lastNDays: 180,
            min: 0.6,
            max: 1,
            weight: 0.4
        },
        votingPower: {
            min: 0.0005,
            max: 0.05,
            weight: 0.1
        },
        blocksMissed: {
            min: 0,
            max: 9500,
        },
        timeInActiveSet: {
            lastNDays: 180,
        },
        slashingEvents: {
            lastNDays: 180,
            max: 0
        },
        validatorBond: {
            min: 0.001,
            max: 0.2,
            weight: 0.1
        }
    }
}
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
        // rpc: "https://cosmos-rpc.polkachu.com:443",
        chainID: "cosmoshub-4",
        prefix: "cosmos",
        feeDenom: "uatom",
        gasPrice: GasPrice.fromString("0.005uatom"),
        pstakeConfig: pstakeHostValsetConfigs.cosmos
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
