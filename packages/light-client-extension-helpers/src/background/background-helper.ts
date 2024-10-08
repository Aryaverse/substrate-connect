import type { ToApplication } from "@substrate/connect-extension-protocol"
import {
  type SubstrateClient,
  createClient,
} from "@polkadot-api/substrate-client"
import { getObservableClient } from "@polkadot-api/observable-client"
import { getSyncProvider } from "@polkadot-api/json-rpc-provider-proxy"
import {
  Observable,
  firstValueFrom,
  catchError,
  defer,
  EMPTY,
  repeat,
} from "rxjs"
import type {
  AddOnAddChainByUserListener,
  LightClientPageHelper,
  PageChain,
} from "./types.js"
import { smoldotProvider } from "./smoldot-provider.js"
import {
  ALARM,
  PORT,
  isSubstrateConnectToExtensionMessage,
} from "../shared/index.js"
import { isRpcMessage, type RpcMessage } from "../utils/index.js"
import * as storage from "../storage/index.js"
import { createBackgroundRpc } from "./createBackgroundRpc.js"
import {
  type Client,
  type Chain,
  type AddChainOptions,
  supervise,
} from "../smoldot/index.js"

export type * from "./types.js"

let isRegistered = false

type RegisterOptions = {
  smoldotClient: Client
  getWellKnownChainSpecs: () => Promise<string[] | Record<string, string>>
}
export const register = ({
  smoldotClient,
  getWellKnownChainSpecs,
}: RegisterOptions) => {
  if (isRegistered) throw new Error("helper already registered")
  isRegistered = true

  supervise(smoldotClient, { onError: console.error })

  const wellKnownChainSpecsPromise: Promise<Record<string, string>> =
    getWellKnownChainSpecs().then(async (chainSpecs) =>
      chainSpecs instanceof Array
        ? Object.fromEntries(
            await Promise.all(
              chainSpecs.map(async (chainSpec) => {
                const { genesisHash } = await getChainData({
                  smoldotClient,
                  chainSpec,
                })
                return [genesisHash, chainSpec] as const
              }),
            ),
          )
        : chainSpecs,
    )

  const initialized = wellKnownChainSpecsPromise
    .then((wellKnownChainSpecs) =>
      Promise.all(
        Object.values(wellKnownChainSpecs).map((chainSpec) =>
          lightClientPageHelper.persistChain(chainSpec),
        ),
      ),
    )
    .catch((error) =>
      console.error("Error persisting well-known chainspecs", error),
    )

  storage.getChains().then((chains) => {
    Object.values(chains).forEach(
      ({ chainSpec, genesisHash, relayChainGenesisHash }) =>
        followChain({
          smoldotClient,
          chainSpec,
          genesisHash,
          relayChainGenesisHash,
        }),
    )
  })

  storage.onChainsChanged((chains) => {
    for (const [genesisHash] of followedChains) {
      if (chains[genesisHash]) continue
      unfollowChain(genesisHash)
    }
    Object.values(chains).forEach(
      ({ genesisHash, chainSpec, relayChainGenesisHash }) => {
        if (followedChains.has(genesisHash)) return
        followChain({
          smoldotClient,
          chainSpec,
          genesisHash,
          relayChainGenesisHash,
        })
      },
    )
  })

  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== ALARM.DATABASE_UPDATE) return
    Object.values(await storage.getChains()).forEach(
      async ({ genesisHash, chainSpec, relayChainGenesisHash }) => {
        try {
          const finalizedDatabase = await getFinalizedDatabase({
            smoldotClient,
            chainSpec,
            databaseContent: await storage.get({
              type: "databaseContent",
              genesisHash,
            }),
            relayChainGenesisHash,
          })
          await storage.set(
            { type: "databaseContent", genesisHash },
            finalizedDatabase,
          )
        } catch (error) {
          console.error("Error updating DB", error)
        }
      },
    )
  })

  chrome.runtime.onInstalled.addListener(({ reason }) => {
    if (
      reason !== chrome.runtime.OnInstalledReason.INSTALL &&
      reason !== chrome.runtime.OnInstalledReason.UPDATE
    )
      return

    chrome.alarms.create(ALARM.DATABASE_UPDATE, {
      periodInMinutes: 2,
    })
  })

  const lightClientPageHelper: LightClientPageHelper = {
    async deleteChain(genesisHash) {
      if ((await wellKnownChainSpecsPromise)[genesisHash])
        throw new Error("Cannot delete well-known-chain")

      await Promise.all([
        storage.remove([
          { type: "chain", genesisHash },
          { type: "bootNodes", genesisHash },
          { type: "databaseContent", genesisHash },
        ]),
        Object.keys(activeChains).map((tabId) =>
          this.disconnect(+tabId, genesisHash),
        ),
      ])
      for (const {
        genesisHash: parachainGenesisHash,
        relayChainGenesisHash,
      } of Object.values(await storage.getChains())) {
        if (relayChainGenesisHash !== genesisHash) continue
        await this.deleteChain(parachainGenesisHash)
      }
    },
    async persistChain(chainSpec, relayChainGenesisHash) {
      const chainData = await getChainData({
        smoldotClient,
        chainSpec,
        relayChainGenesisHash,
      })
      if (
        await storage.get({ type: "chain", genesisHash: chainData.genesisHash })
      )
        return

      const chainSpecJson = JSON.parse(chainSpec)
      const bootNodes = chainSpecJson.bootNodes
      let minimalChainSpec: string = ""
      delete chainSpecJson.bootNodes
      delete chainSpecJson.protocolId
      delete chainSpecJson.telemetryEndpoints

      if (!chainSpecJson.genesis.stateRootHash) {
        chainSpecJson.genesis.stateRootHash = await getGenesisStateRoot({
          smoldotClient,
          chainSpec,
          relayChainGenesisHash,
        })
      }

      // TODO: check if .lightSyncState could be removed and use chainHead_unstable_finalizedDatabase

      minimalChainSpec = JSON.stringify(chainSpecJson)

      await Promise.all([
        storage.set(
          { type: "chain", genesisHash: chainData.genesisHash },
          {
            ...chainData,
            chainSpec: minimalChainSpec,
            relayChainGenesisHash,
          },
        ),
        storage.set(
          { type: "bootNodes", genesisHash: chainData.genesisHash },
          bootNodes,
        ),
      ])
    },
    async getChain(genesisHash) {
      return this.getChains()
        .then((chains) =>
          chains.find((chain) => chain.genesisHash === genesisHash),
        )
        .then((chain) => chain ?? null)
    },
    async getChains() {
      const chains = await storage.getChains()
      return Promise.all(
        Object.entries(chains).map(async ([genesisHash, chain]) => ({
          ...chain,
          bootNodes:
            (await storage.get({ type: "bootNodes", genesisHash })) ??
            (JSON.parse(chain.chainSpec).bootNodes as string[]),
          provider: await createSmoldotProvider({
            smoldotClient,
            chainSpec: chain.chainSpec,
            genesisHash: chain.genesisHash,
            relayChainGenesisHash: chain.relayChainGenesisHash,
          }),
        })),
      )
    },
    async getActiveConnections() {
      return Object.entries(activeChains).reduce(
        (acc, [tabIdStr, tabChains]) => {
          const tabId = parseInt(tabIdStr)
          Object.values(tabChains).forEach(
            ({
              genesisHash,
              name,
              ss58Format,
              bootNodes,
              chainSpec,
              relayChainGenesisHash,
            }) =>
              acc.push({
                tabId,
                chain: {
                  genesisHash,
                  chainSpec,
                  relayChainGenesisHash,
                  name,
                  ss58Format,
                  bootNodes,
                  provider: createSmoldotSyncProvider({
                    smoldotClient,
                    chainSpec,
                    genesisHash,
                    relayChainGenesisHash,
                  }),
                },
              }),
          )
          return acc
        },
        [] as { tabId: number; chain: PageChain }[],
      )
    },
    async disconnect(tabId: number, genesisHash: string) {
      Object.entries(activeChains[tabId] ?? {})
        .filter(
          ([_, { genesisHash: activeGenesisHash }]) =>
            activeGenesisHash === genesisHash,
        )
        .forEach(([chainId]) => {
          removeChain(tabId, chainId)
          chrome.tabs.sendMessage(tabId, {
            origin: "substrate-connect-extension",
            type: "error",
            chainId,
            errorMessage: "Disconnected",
          } as ToApplication)
        })
    },
    setBootNodes(genesisHash, bootNodes) {
      return storage.set({ type: "bootNodes", genesisHash }, bootNodes)
    },
  }

  // Chains by TabId
  const activeChains: Record<
    number,
    Record<
      string,
      {
        chain: Chain
        genesisHash: string
        chainSpec: string
        relayChainGenesisHash?: string
        name: string
        ss58Format: number
        bootNodes: Array<string>
      }
    >
  > = {}
  const helperPortNames: string[] = [
    PORT.CONTENT_SCRIPT,
    PORT.EXTENSION_PAGE,
    PORT.WEB_PAGE,
  ]
  chrome.runtime.onConnect.addListener((port) => {
    if (!helperPortNames.includes(port.name)) return

    // use chrome.tabs.TAB_ID_NONE for popup port
    const tabId = port.sender?.tab?.id ?? chrome.tabs.TAB_ID_NONE

    const postMessage = (message: ToApplication | RpcMessage) =>
      port.postMessage(message)

    const rpc = createBackgroundRpc(postMessage)

    const unsubscribeOnChainsChanged = storage.onChainsChanged((chains) =>
      rpc.notify("onAddChains", [chains]),
    )

    let isPortDisconnected = false
    port.onDisconnect.addListener(() => {
      isPortDisconnected = true
      unsubscribeOnChainsChanged()
      if (!activeChains[tabId]) return
      for (const [chainId, { chain }] of Object.entries(activeChains[tabId])) {
        try {
          chain.remove()
        } catch (error) {
          console.error("error removing chain", error)
        }
        delete activeChains[tabId][chainId]
      }
      delete activeChains[tabId]
    })

    const pendingAddChains: Record<string, boolean> = {}
    port.onMessage.addListener(async (msg) => {
      await initialized
      if (isRpcMessage(msg))
        return rpc.handle(msg, {
          port,
          lightClientPageHelper,
          addChainByUserListener,
          getChainData: ({ chainSpec, relayChainGenesisHash }) =>
            getChainData({
              smoldotClient,
              chainSpec,
              relayChainGenesisHash,
            }),
        })
      else if (isSubstrateConnectToExtensionMessage(msg))
        switch (msg.type) {
          case "add-well-known-chain":
          case "add-chain": {
            activeChains[tabId] ??= {}
            try {
              if (
                activeChains[tabId][msg.chainId] ||
                pendingAddChains[msg.chainId]
              )
                throw new Error("Requested chainId already in use")

              pendingAddChains[msg.chainId] = true
              const chains = await storage.getChains()

              let addChainOptions: AddChainOptions
              if (msg.type === "add-well-known-chain") {
                const chain =
                  Object.values(chains).find(
                    (chain) => chain.genesisHash === msg.chainName,
                  ) ??
                  Object.values(chains).find(
                    (chain) => chain.name === msg.chainName,
                  )
                if (!chain) throw new Error("Unknown well-known chain")
                addChainOptions = {
                  chainSpec: chain.chainSpec,
                  disableJsonRpc: false,
                  potentialRelayChains: chain.relayChainGenesisHash
                    ? [
                        {
                          chainSpec:
                            chains[chain.relayChainGenesisHash].chainSpec,
                          disableJsonRpc: true,
                          databaseContent: await storage.get({
                            type: "databaseContent",
                            genesisHash: chain.relayChainGenesisHash,
                          }),
                        },
                      ]
                    : [],
                  databaseContent: await storage.get({
                    type: "databaseContent",
                    genesisHash: chain.genesisHash,
                  }),
                }
              } else {
                const relayChainGenesisHashOrChainId =
                  msg.potentialRelayChainIds[0]
                addChainOptions = {
                  chainSpec: msg.chainSpec,
                  disableJsonRpc: false,
                  potentialRelayChains: chains[relayChainGenesisHashOrChainId]
                    ? [
                        {
                          chainSpec:
                            chains[relayChainGenesisHashOrChainId].chainSpec,
                          disableJsonRpc: true,
                          databaseContent: await storage.get({
                            type: "databaseContent",
                            genesisHash: relayChainGenesisHashOrChainId,
                          }),
                        },
                      ]
                    : msg.potentialRelayChainIds
                        .filter((chainId) => activeChains[tabId][chainId])
                        .map((chainId) => ({
                          chainSpec: activeChains[tabId][chainId].chainSpec,
                          disableJsonRpc: true,
                        })),
                }
              }

              const [smoldotChain, { genesisHash, name, ss58Format }] =
                await Promise.all([
                  smoldotClient.addChain(addChainOptions),
                  getChainData({ smoldotClient, addChainOptions }),
                ])

              ;(async () => {
                while (true) {
                  let jsonRpcMessage: string | undefined
                  try {
                    jsonRpcMessage = await smoldotChain.nextJsonRpcResponse()
                  } catch (_) {
                    break
                  }

                  if (isPortDisconnected) break

                  // `nextJsonRpcResponse` throws an exception if we pass `disableJsonRpc: true` in the
                  // config. We pass `disableJsonRpc: true` if `jsonRpcCallback` is undefined. Therefore,
                  // this code is never reachable if `jsonRpcCallback` is undefined.
                  try {
                    postMessage({
                      origin: "substrate-connect-extension",
                      type: "rpc",
                      chainId: msg.chainId,
                      jsonRpcMessage,
                    })
                  } catch (error) {
                    console.error(
                      "JSON-RPC callback has thrown an exception:",
                      error,
                    )
                  }
                }
              })()

              if (!pendingAddChains[msg.chainId]) {
                smoldotChain.remove()
                return
              }
              delete pendingAddChains[msg.chainId]

              // FIXME: double check this and dedupe from above
              let relayChainGenesisHash: string | undefined = undefined
              if (msg.type === "add-chain") {
                const relayChainGenesisHashOrChainId =
                  msg.potentialRelayChainIds[0]
                relayChainGenesisHash = chains[relayChainGenesisHashOrChainId]
                  ? chains[relayChainGenesisHashOrChainId].genesisHash
                  : msg.potentialRelayChainIds
                      .filter((chainId) => activeChains[tabId][chainId])
                      .map(
                        (chainId) => activeChains[tabId][chainId].genesisHash,
                      )[0]
              }

              activeChains[tabId][msg.chainId] = {
                chain: smoldotChain,
                genesisHash,
                relayChainGenesisHash,
                chainSpec: addChainOptions.chainSpec,
                name,
                ss58Format,
                bootNodes:
                  JSON.parse(addChainOptions.chainSpec)?.bootNodes ?? [],
              }

              postMessage({
                origin: "substrate-connect-extension",
                type: "chain-ready",
                chainId: msg.chainId,
              })
            } catch (error) {
              delete pendingAddChains[msg.chainId]
              postMessage({
                origin: "substrate-connect-extension",
                type: "error",
                chainId: msg.chainId,
                errorMessage:
                  error instanceof Error
                    ? error.toString()
                    : "Unknown error when adding chain",
              })
            }

            break
          }
          case "remove-chain": {
            delete pendingAddChains[msg.chainId]

            removeChain(tabId, msg.chainId)

            break
          }
          case "rpc": {
            const chain = activeChains?.[tabId]?.[msg.chainId]?.chain
            if (!chain) return

            try {
              chain.sendJsonRpc(msg.jsonRpcMessage)
            } catch (error) {
              removeChain(tabId, msg.chainId)
              postMessage({
                origin: "substrate-connect-extension",
                type: "error",
                chainId: msg.chainId,
                errorMessage:
                  error instanceof Error
                    ? error.toString()
                    : "Unknown error when sending RPC message",
              })
            }

            break
          }
          default: {
            const unrecognizedMsg: never = msg
            console.warn("Unrecognized message", unrecognizedMsg)
            break
          }
        }
      else console.warn("Unrecognized message", msg)
    })
  })

  let addChainByUserListener:
    | Parameters<AddOnAddChainByUserListener>[0]
    | undefined = undefined

  const addOnAddChainByUserListener: AddOnAddChainByUserListener = async (
    onAddChainByUser,
  ) => {
    if (addChainByUserListener)
      throw new Error("addChainByUserCallback is already set")
    addChainByUserListener = onAddChainByUser
  }

  const removeChain = (tabId: number, chainId: string) => {
    const chain = activeChains?.[tabId]?.[chainId]?.chain
    delete activeChains?.[tabId]?.[chainId]
    try {
      chain?.remove()
    } catch (error) {
      console.error("error removing chain", error)
    }
  }

  return { lightClientPageHelper, addOnAddChainByUserListener }
}

const withClient =
  <T>(fn: (client: SubstrateClient) => T | Promise<T>) =>
  async (
    options:
      | { smoldotClient: Client; addChainOptions: AddChainOptions }
      | {
          smoldotClient: Client
          chainSpec: string
          databaseContent?: string
          relayChainGenesisHash?: string
        },
  ) => {
    const client = createClient(
      await smoldotProvider(
        "addChainOptions" in options
          ? options
          : {
              smoldotClient: options.smoldotClient,
              chainSpec: options.chainSpec,
              databaseContent: options.databaseContent,
              relayChainSpec: options.relayChainGenesisHash
                ? (await storage.getChains())[options.relayChainGenesisHash]
                    .chainSpec
                : undefined,
              relayChainDatabaseContent: options.relayChainGenesisHash
                ? await storage.get({
                    type: "databaseContent",
                    genesisHash: options.relayChainGenesisHash,
                  })
                : undefined,
            },
      ),
    )
    try {
      return await fn(client)
    } finally {
      client.destroy()
    }
  }

const withClientChainHead$ = <T>(
  fn: (
    chainHead: ReturnType<ReturnType<typeof getObservableClient>["chainHead$"]>,
    client: SubstrateClient,
  ) => T | Promise<T>,
) =>
  withClient(async (client) => {
    const chainHead = getObservableClient(client).chainHead$()
    try {
      return await fn(chainHead, client)
    } finally {
      chainHead.unfollow()
    }
  })

const getChainData = withClient(async (client) => {
  const [genesisHash, name, { ss58Format }] = (await Promise.all(
    [
      "chainSpec_v1_genesisHash",
      "chainSpec_v1_chainName",
      "chainSpec_v1_properties",
    ].map((method) => substrateClientRequest(client, method)),
  )) as [string, string, { ss58Format: number }]
  return {
    genesisHash,
    name,
    ss58Format,
  }
})

// TODO: update this implementation when these issues are implemented
// https://github.com/paritytech/json-rpc-interface-spec/issues/110
// https://github.com/smol-dot/smoldot/issues/1186
const getGenesisStateRoot = withClientChainHead$(
  async ({ runtime$ }, client) => {
    await firstValueFrom(runtime$)
    const genesisHash = await substrateClientRequest<string>(
      client,
      "chainSpec_v1_genesisHash",
    )
    const { stateRoot } = await substrateClientRequest<{
      stateRoot: string
    }>(client, "chain_getHeader", [genesisHash])
    return stateRoot
  },
)

const getFinalizedDatabase = withClientChainHead$(
  async ({ runtime$ }, client) => {
    await firstValueFrom(runtime$)
    const finalizedDatabase = await substrateClientRequest<string>(
      client,
      "chainHead_unstable_finalizedDatabase",
      (await chrome.permissions.contains({
        permissions: ["unlimitedStorage"],
      }))
        ? []
        : // 1mb will strip the runtime code
          // See https://github.com/smol-dot/smoldot/blob/0a9e9cd802169bc07dd681e55278fd67c6f8f9bc/light-base/src/database.rs#L134-L140
          [1024 * 1024],
    )
    return finalizedDatabase
  },
)

const substrateClientRequest = <T>(
  client: SubstrateClient,
  method: string,
  params: any[] = [],
) =>
  new Promise<T>((resolve, reject) => {
    try {
      client._request(method, params, {
        onSuccess: resolve,
        onError: reject,
      })
    } catch (error) {
      reject(error)
    }
  })

const followedChains = new Map<string, () => void>()
const followChain = ({
  smoldotClient,
  chainSpec,
  genesisHash,
  relayChainGenesisHash,
}: {
  smoldotClient: Client
  chainSpec: string
  genesisHash: string
  relayChainGenesisHash?: string
}) => {
  const makeClient = () =>
    getObservableClient(
      createClient(
        createSmoldotSyncProvider({
          smoldotClient,
          chainSpec,
          genesisHash,
          relayChainGenesisHash,
        }),
      ),
    )

  const subscription = new Observable<boolean>((observer) => {
    observer.next(false)
    let client = makeClient()
    let unfollow: ReturnType<(typeof client)["chainHead$"]>["unfollow"]
    const finalizedSubscription = defer(() => {
      const chainHead = client.chainHead$()
      unfollow = chainHead.unfollow
      return chainHead.finalized$
    })
      .pipe(
        catchError(() => {
          // restart the entire client to ensure no blocks ever get stuck
          const oldClient = client
          client = makeClient()
          try {
            oldClient.destroy()
          } catch {}
          return EMPTY
        }),
        repeat({ delay: 1 }),
      )
      .subscribe({
        next() {
          observer.next(true)
        },
        error: observer.error,
        complete: observer.complete,
      })

    return () => {
      finalizedSubscription.unsubscribe()
      unfollow()
      client.destroy()
    }
  }).subscribe()
  followedChains.set(genesisHash, () => {
    followedChains.delete(genesisHash)
    subscription.unsubscribe()
  })
}

const unfollowChain = (genesisHash: string) => {
  followedChains.get(genesisHash)?.()
}

type CreateSmoldotProviderOptions = {
  smoldotClient: Client
  chainSpec: string
  genesisHash: string
  relayChainGenesisHash?: string
}
const createSmoldotProvider = async ({
  smoldotClient,
  chainSpec,
  genesisHash,
  relayChainGenesisHash,
}: CreateSmoldotProviderOptions) =>
  smoldotProvider({
    smoldotClient,
    chainSpec,
    relayChainSpec: relayChainGenesisHash
      ? (await storage.getChains())[relayChainGenesisHash].chainSpec
      : undefined,
    databaseContent: await storage.get({
      type: "databaseContent",
      genesisHash,
    }),
    relayChainDatabaseContent: relayChainGenesisHash
      ? await storage.get({
          type: "databaseContent",
          genesisHash: relayChainGenesisHash,
        })
      : undefined,
  })

const createSmoldotSyncProvider = (options: CreateSmoldotProviderOptions) =>
  getSyncProvider(() => createSmoldotProvider(options))
