import {Tendermint34Client, Tendermint37Client} from "@cosmjs/tendermint-rpc";
import {createProtobufRpcClient, QueryClient, SigningStargateClient} from "@cosmjs/stargate";
import {decodePubkey, DirectSecp256k1HdWallet, Registry} from "@cosmjs/proto-signing";
import {defaultRegistryTypes as defaultStargateTypes} from "@cosmjs/stargate/build/signingstargateclient.js";
import {registry as liquidstakeRegistry} from "persistenceonejs/pstake/liquidstake/v1beta1/tx.registry.js";
import {registry as liquidstakeibcRegistry} from "persistenceonejs/pstake/liquidstakeibc/v1beta1/msgs.registry.js";
import {registry as lscosmosRegistry} from "persistenceonejs/pstake/lscosmos/v1beta1/msgs.registry.js";
import {registry as govv1Registry} from "persistenceonejs/cosmos/gov/v1/tx.registry.js";
import {COMETBFT_VERSIONS, MNEMONIC} from "./constants.js";
import {Long} from "cosmjs-types/helpers";
import {fromBase64, fromBech32, toBech32} from "@cosmjs/encoding";
import {sha256} from "@cosmjs/crypto";
import {buildQuery} from "@cosmjs/tendermint-rpc/build/tendermint34/requests.js";

export const CustomRegistry = new Registry([...defaultStargateTypes, ...liquidstakeRegistry,
    ...liquidstakeibcRegistry, ...lscosmosRegistry, ...govv1Registry]);

export async function RpcClient(chainInfo) {
    let tendermintClient = {}
    switch (chainInfo.tmVersion) {
        case COMETBFT_VERSIONS.comet34:
            tendermintClient = await Tendermint34Client.connect(chainInfo.rpc);
        case COMETBFT_VERSIONS.comet37:
            tendermintClient = await Tendermint37Client.connect(chainInfo.rpc);
        case COMETBFT_VERSIONS.comet38:
            tendermintClient = await Tendermint37Client.connect(chainInfo.rpc);
    }
    const queryClient = new QueryClient(tendermintClient);
    return [tendermintClient, createProtobufRpcClient(queryClient)];
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

export function ChangeAddressPrefix(address, prefix) {
    let decoded = fromBech32(address)
    return toBech32(prefix, decoded.data)
}

export function ValidatorPubkeyToBech32(validatorPubKey, prefix) {

    let valConsPubKey = decodePubkey(validatorPubKey)
    const ed25519PubkeyRaw = fromBase64(valConsPubKey.value);
    const addressData = sha256(ed25519PubkeyRaw).slice(0, 20);

    return toBech32(prefix, addressData)
}

export function txSearchParams(tags, pageNumber, perPage) {
    // tags = [{key: "message.sender", value: "persistence1xxx"}]
    return {
        query: buildQuery({
            tags: tags,
        }),
        page: pageNumber,
        per_page: perPage,
        order_by: "desc" //latest first
    }
}

export function stringifyJson(data) {
    return JSON.stringify(data, (key, value) =>
        typeof value === "bigint" ? value.toString() + "b" : value
    );

}

export function parseJson(json) {
    return JSON.parse(json, (key, value) => {
        if (typeof value === "string" && /^\d+b$/.test(value)) {
            return BigInt(value.substr(0, value.length - 1));
        }
        return value;
    })
}