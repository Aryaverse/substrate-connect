import {
  getDynamicBuilder,
  type MetadataLookup,
} from "@polkadot-api/metadata-builders"
import { Storage, Twox64Concat, u32 } from "@polkadot-api/substrate-bindings"
import { fromHex } from "@polkadot-api/utils"
import { map, noop, of } from "rxjs"
import type { ChainExtensionCtx } from "./internal-types.js"

export const empty = new Uint8Array()

const genesisHashStorageKey = Storage("System")("BlockHash", noop, [
  u32,
  Twox64Concat,
]).enc(0)

export const genesisHashFromCtx = (ctx: ChainExtensionCtx) =>
  ctx.chainHead
    .storage$(ctx.at, "value", () => genesisHashStorageKey, null)
    .pipe(map((result) => fromHex(result!)))

export const systemVersionProp$ = (
  propName: string,
  lookupFn: MetadataLookup,
) => {
  const dynamicBuilder = getDynamicBuilder(lookupFn)

  const constant = lookupFn.metadata.pallets
    .find((x) => x.name === "System")!
    .constants!.find((s) => s.name === "Version")!

  const systemVersion = lookupFn(constant.type)
  const systemVersionDec = dynamicBuilder.buildDefinition(constant.type).dec

  if (systemVersion.type !== "struct") throw new Error("not a struct")

  const valueEnc = dynamicBuilder.buildDefinition(
    systemVersion.value[propName].id,
  ).enc

  return of(valueEnc(systemVersionDec(constant.value)[propName]))
}
