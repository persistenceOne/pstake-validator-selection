import {Tendermint34Client} from "@cosmjs/tendermint-rpc";
import {
    createProtobufRpcClient,
    QueryClient,
    SigningStargateClient
} from "@cosmjs/stargate";
import {DirectSecp256k1HdWallet, Registry} from "@cosmjs/proto-signing";
import {defaultRegistryTypes as defaultStargateTypes} from "@cosmjs/stargate/build/signingstargateclient.js";
import {registry as liquidstakeibcRegistry} from "persistenceonejs/pstake/liquidstakeibc/v1beta1/msgs.registry.js";
import {MNEMONIC} from "./constants.js";
import {Long} from "cosmjs-types/helpers";

export const CustomRegistry = new Registry([...defaultStargateTypes, ...liquidstakeibcRegistry]);

export async function RpcClient(rpc) {
    const tendermintClient = await Tendermint34Client.connect(rpc);
    const queryClient = new QueryClient(tendermintClient);
    return createProtobufRpcClient(queryClient);
}

export async function CreateWallet(address) {
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, {
        prefix: address.prefix,
        hdPaths: [address.hdPath]
    });
    const [firstAccount] = await wallet.getAccounts();
    if (firstAccount.address !== address.address) {
        throw new Error("Incorrect address generated, expected: " + address.address + ",got: " + firstAccount.address);
    }
    return [wallet, firstAccount]
}

export async function CreateSigningClient(chainInfo, wallet) {
    return await SigningStargateClient.connectWithSigner(chainInfo.rpc, wallet, {
        prefix: chainInfo.prefix,
        registry: CustomRegistry,
        gasPrice: chainInfo.gasPrice,
    })
}

export async function CreateSigningClientFromAddress(address) {
    const [wallet, _] = await CreateWallet(address)
    return CreateSigningClient(address.chainInfo, wallet)
}

export async function AllPaginatedQuery(queryFunc, queryArgs, aggregationKey) {
    let key = new Uint8Array();
    let totalElements = [];

    do {
        queryArgs.pagination = {
            key: key,
            offset: Long.fromNumber(0, true),
            limit: Long.fromNumber(0, true),
            countTotal: true
        }
        const response = await queryFunc(queryArgs)
        key = response.pagination.nextKey;
        totalElements.push(...response[aggregationKey]);
    } while (key.length !== 0);

    return totalElements
}