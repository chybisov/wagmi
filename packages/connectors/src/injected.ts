import {
  ChainNotConfiguredError,
  ProviderNotFoundError,
  createConnector,
  normalizeChainId,
} from '@wagmi/core'
import type { Evaluate } from '@wagmi/core/internal'
import {
  type Address,
  type EIP1193Provider,
  type ProviderConnectInfo,
  ProviderRpcError,
  ResourceUnavailableRpcError,
  RpcError,
  SwitchChainError,
  UserRejectedRequestError,
  getAddress,
  numberToHex,
} from 'viem'

export type InjectedParameters = {
  /**
   * MetaMask and other injected providers do not support programmatic disconnect.
   * This flag simulates the disconnect behavior by keeping track of connection status in storage. See [GitHub issue](https://github.com/MetaMask/metamask-extension/issues/10353) for more info.
   * @default true
   */
  shimDisconnect?: boolean | undefined
  unstable_shimAsyncInject?: boolean | number | undefined
  /**
   * [EIP-1193](https://eips.ethereum.org/EIPS/eip-1193) Ethereum Provider to target
   */
  target?:
    | TargetId
    | (() => (TargetMap[TargetId] & { id: string }) | undefined)
    | undefined
}

const targetMap = {
  coinbaseWallet: {
    name: 'Coinbase Wallet',
    provider(window) {
      if (window?.coinbaseWalletExtension) return window.coinbaseWalletExtension
      return findProvider(window, 'isCoinbaseWallet')
    },
  },
  metaMask: {
    name: 'MetaMask',
    provider(window) {
      return findProvider(window, (windowProvider) => {
        if (!windowProvider.isMetaMask) return false
        // Brave tries to make itself look like MetaMask
        // Could also try RPC `web3_clientVersion` if following is unreliable
        if (
          windowProvider.isBraveWallet &&
          !windowProvider._events &&
          !windowProvider._state
        )
          return false
        // Other wallets that try to look like MetaMask
        const flags: (keyof WindowProviderFlags)[] = [
          'isApexWallet',
          'isAvalanche',
          'isBitKeep',
          'isBlockWallet',
          'isKuCoinWallet',
          'isMathWallet',
          'isOkxWallet',
          'isOKExWallet',
          'isOneInchIOSWallet',
          'isOneInchAndroidWallet',
          'isOpera',
          'isPortal',
          'isRabby',
          'isTokenPocket',
          'isTokenary',
          'isZerion',
        ]
        for (const flag of flags) if (windowProvider[flag]) return false
        return true
      })
    },
    features: ['wallet_requestPermissions'],
  },
  phantom: {
    name: 'Phantom',
    provider(window) {
      if (window?.phantom?.ethereum) return window.phantom?.ethereum
      return findProvider(window, 'isPhantom')
    },
  },
} as const satisfies TargetMap

export function injected(parameters: InjectedParameters = {}) {
  const shimDisconnect = parameters.shimDisconnect ?? true
  const unstable_shimAsyncInject = parameters.unstable_shimAsyncInject

  function getWindowProvider(): TargetMap[TargetId] & { id: string } {
    const target = parameters.target
    if (typeof target === 'function') {
      const result = target()
      if (result) return result
    }
    if (typeof target === 'string')
      return {
        ...(targetMap[target as keyof typeof targetMap] ?? {
          name: `${target[0]!.toUpperCase()}${target.slice(1)}`,
          provider: `is${target[0]!.toUpperCase()}${target.slice(1)}`,
        }),
        id: target,
      }
    return {
      id: 'injected',
      name: 'Injected',
      provider(window) {
        return window?.ethereum
      },
    }
  }

  type Provider = WindowProvider | undefined
  type Properties = {
    onConnect(connectInfo: ProviderConnectInfo): void
  }
  type StorageItem = { [_ in `${string}.connected`]: true }

  return createConnector<Provider, Properties, StorageItem>((config) => ({
    get id() {
      return getWindowProvider().id
    },
    get name() {
      return getWindowProvider().name
    },
    async setup() {
      const provider = await this.getProvider()
      // Only start listening for events if `target` is set, otherwise `injected()` will also receive events
      if (provider && parameters.target) {
        provider.on('accountsChanged', this.onAccountsChanged.bind(this))
        provider.on('connect', this.onConnect.bind(this))
      }
    },
    async connect({ chainId } = {}) {
      const provider = await this.getProvider()
      if (!provider) throw new ProviderNotFoundError()

      try {
        // Attempt to show select prompt with `wallet_requestPermissions` when
        // `shimDisconnect` is active and account is in disconnected state (flag in storage)
        const canSelectAccount = getWindowProvider().features?.includes(
          'wallet_requestPermissions',
        )
        const isDisconnected =
          shimDisconnect &&
          !(await config.storage?.getItem(`${this.id}.connected`))

        let accounts: readonly Address[] | null = null
        if (canSelectAccount && isDisconnected) {
          accounts = await this.getAccounts().catch(() => null)
          const isAuthorized = !!accounts?.length
          if (isAuthorized)
            // Attempt to show another prompt for selecting connector if already connected
            try {
              const permissions = await provider.request({
                method: 'wallet_requestPermissions',
                params: [{ eth_accounts: {} }],
              })
              accounts = permissions[0]?.caveats?.[0]?.value?.map(getAddress)
            } catch (error) {
              // Not all injected providers support `wallet_requestPermissions` (e.g. MetaMask iOS).
              // Only bubble up error if user rejects request
              if ((error as ProviderRpcError).code === 4_001)
                throw new UserRejectedRequestError(error as RpcError)
              // Or prompt is already open
              if (
                (error as RpcError).code ===
                new ResourceUnavailableRpcError(error as Error).code
              )
                throw error
            }
        }

        if (!accounts?.length) {
          const accounts_ = await provider.request({
            method: 'eth_requestAccounts',
          })
          accounts = accounts_.map(getAddress)
        }

        provider.removeListener('connect', this.onConnect.bind(this))
        provider.on('accountsChanged', this.onAccountsChanged.bind(this))
        provider.on('chainChanged', this.onChainChanged)
        provider.on('disconnect', this.onDisconnect.bind(this))

        // Switch to chain if provided
        let currentChainId = await this.getChainId()
        if (chainId && currentChainId !== chainId) {
          const chain = await this.switchChain?.({ chainId }).catch(() => ({
            id: currentChainId,
          }))
          currentChainId = chain?.id ?? currentChainId
        }

        // Add shim to storage signalling connector is connected
        if (shimDisconnect)
          await config.storage?.setItem(`${this.id}.connected`, true)

        return { accounts, chainId: currentChainId }
      } catch (error) {
        if ((error as ProviderRpcError).code === 4_001)
          throw new UserRejectedRequestError(error as RpcError)
        if ((error as RpcError).code === -32_002)
          throw new ResourceUnavailableRpcError(error as RpcError)
        throw error
      }
    },
    async disconnect() {
      const provider = await this.getProvider()
      if (!provider) throw new ProviderNotFoundError()

      provider.removeListener(
        'accountsChanged',
        this.onAccountsChanged.bind(this),
      )
      provider.removeListener('chainChanged', this.onChainChanged)
      provider.removeListener('disconnect', this.onDisconnect.bind(this))
      provider.on('connect', this.onConnect.bind(this))

      // Remove shim signalling connector is disconnected
      if (shimDisconnect)
        await config.storage?.removeItem(`${this.id}.connected`)
    },
    async getAccounts() {
      const provider = await this.getProvider()
      if (!provider) throw new ProviderNotFoundError()
      const accounts = await provider.request({ method: 'eth_accounts' })
      return accounts.map(getAddress)
    },
    async getChainId() {
      const provider = await this.getProvider()
      if (!provider) throw new ProviderNotFoundError()
      const hexChainId = await provider.request({ method: 'eth_chainId' })
      return normalizeChainId(hexChainId)
    },
    async getProvider() {
      if (typeof window === 'undefined') return undefined
      const windowProvider = getWindowProvider()
      if (typeof windowProvider.provider === 'function')
        return windowProvider.provider(window as Window | undefined)
      return findProvider(window as Window | undefined, () => true)
    },
    async isAuthorized() {
      try {
        const isDisconnected =
          shimDisconnect &&
          // If shim does not exist in storage, connector is disconnected
          !(await config.storage?.getItem(`${this.id}.connected`))
        if (isDisconnected) return false

        const provider = await this.getProvider()
        if (!provider) {
          if (
            unstable_shimAsyncInject !== undefined &&
            unstable_shimAsyncInject !== false
          ) {
            // If no provider is found, check for async injection
            // https://github.com/wagmi-dev/references/issues/167
            // https://github.com/MetaMask/detect-provider
            const handleEthereum = async () => {
              if (typeof window !== 'undefined')
                window.removeEventListener(
                  'ethereum#initialized',
                  handleEthereum,
                )
              const provider = await this.getProvider()
              return !!provider
            }
            const timeout =
              typeof unstable_shimAsyncInject === 'number'
                ? unstable_shimAsyncInject
                : 1_000
            const res = await Promise.race([
              ...(typeof window !== 'undefined'
                ? [
                    new Promise<boolean>((resolve) =>
                      window.addEventListener(
                        'ethereum#initialized',
                        () => resolve(handleEthereum()),
                        { once: true },
                      ),
                    ),
                  ]
                : []),
              new Promise<boolean>((resolve) =>
                setTimeout(() => resolve(handleEthereum()), timeout),
              ),
            ])
            if (res) return true
          }

          throw new ProviderNotFoundError()
        }
        const accounts = await this.getAccounts()
        return !!accounts.length
      } catch {
        return false
      }
    },
    async switchChain({ chainId }) {
      const provider = await this.getProvider()
      if (!provider) throw new ProviderNotFoundError()

      const chain = config.chains.find((x) => x.id === chainId)
      if (!chain) throw new SwitchChainError(new ChainNotConfiguredError())

      const id = numberToHex(chainId)

      try {
        await Promise.all([
          provider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: id }],
          }),
          new Promise<void>((resolve) =>
            config.emitter.once('change', ({ chainId: currentChainId }) => {
              if (currentChainId === chainId) resolve()
            }),
          ),
        ])
        return chain
      } catch (error) {
        // Indicates chain is not added to provider
        if (
          (error as ProviderRpcError).code === 4902 ||
          // Unwrapping for MetaMask Mobile
          // https://github.com/MetaMask/metamask-mobile/issues/2944#issuecomment-976988719
          (error as ProviderRpcError<{ originalError?: { code: number } }>)
            ?.data?.originalError?.code === 4902
        ) {
          try {
            const { default: blockExplorer, ...blockExplorers } =
              chain.blockExplorers ?? {}
            let blockExplorerUrls: string[] = []
            if (blockExplorer)
              blockExplorerUrls = [
                blockExplorer.url,
                ...Object.values(blockExplorers).map((x) => x.url),
              ]

            await provider.request({
              method: 'wallet_addEthereumChain',
              params: [
                {
                  chainId: id,
                  chainName: chain.name,
                  nativeCurrency: chain.nativeCurrency,
                  rpcUrls: [chain.rpcUrls.public?.http[0] ?? ''],
                  blockExplorerUrls,
                },
              ],
            })

            const currentChainId = await this.getChainId()
            if (currentChainId !== chainId)
              throw new UserRejectedRequestError(
                new Error('User rejected switch after adding network.'),
              )

            return chain
          } catch (error) {
            throw new UserRejectedRequestError(error as Error)
          }
        }

        if ((error as ProviderRpcError).code === 4_001)
          throw new UserRejectedRequestError(error as RpcError)
        throw new SwitchChainError(error as RpcError)
      }
    },
    async onAccountsChanged(accounts) {
      // Disconnect if there are no accounts
      if (accounts.length === 0) this.onDisconnect()
      // Connect if emitter is listening for connect event (e.g. is disconnected)
      else if (config.emitter.listenerCount('connect')) {
        const chainId = (await this.getChainId()).toString()
        this.onConnect({ chainId })
      }
      // Regular change event
      else config.emitter.emit('change', { accounts: accounts.map(getAddress) })
    },
    onChainChanged(chain) {
      const chainId = normalizeChainId(chain)
      config.emitter.emit('change', { chainId })
    },
    async onConnect(connectInfo) {
      const accounts = await this.getAccounts()
      if (accounts.length === 0) return

      const chainId = normalizeChainId(connectInfo.chainId)
      config.emitter.emit('connect', { accounts, chainId })

      const provider = await this.getProvider()
      if (provider) {
        provider.removeListener('connect', this.onConnect.bind(this))
        provider.on('accountsChanged', this.onAccountsChanged.bind(this))
        provider.on('chainChanged', this.onChainChanged)
        provider.on('disconnect', this.onDisconnect.bind(this))
      }

      // Add shim to storage signalling connector is connected
      if (shimDisconnect)
        await config.storage?.setItem(`${this.id}.connected`, true)
    },
    async onDisconnect(error) {
      const provider = await this.getProvider()

      // If MetaMask emits a `code: 1013` error, wait for reconnection before disconnecting
      // https://github.com/MetaMask/providers/pull/120
      if (error && (error as RpcError<1013>).code === 1013) {
        if (provider && !!(await this.getAccounts()).length) return
      }

      // No need to remove `shimDisconnectStorageKey` from storage because `onDisconnect` is typically
      // only called when the wallet is disconnected through the wallet's interface, meaning the wallet
      // actually disconnected and we don't need to simulate it.
      config.emitter.emit('disconnect')

      if (provider) {
        provider.removeListener(
          'accountsChanged',
          this.onAccountsChanged.bind(this),
        )
        provider.removeListener('chainChanged', this.onChainChanged)
        provider.removeListener('disconnect', this.onDisconnect.bind(this))
        provider.on('connect', this.onConnect.bind(this))
      }
    },
  }))
}

export type TargetId = Evaluate<
  keyof WindowProviderFlags
> extends `is${infer name}`
  ? name extends `${infer char}${infer rest}`
    ? `${Lowercase<char>}${rest}`
    : never
  : never

type Target = {
  name: string
  provider:
    | keyof WindowProviderFlags
    | ((window?: Window | undefined) => WindowProvider | undefined)
  features?: readonly 'wallet_requestPermissions'[] | undefined
}
type TargetMap = { [_ in TargetId]?: Target | undefined }

type WindowProviderFlags = {
  isApexWallet?: true | undefined
  isAvalanche?: true | undefined
  isBackpack?: true | undefined
  isBifrost?: true | undefined
  isBitKeep?: true | undefined
  isBitski?: true | undefined
  isBlockWallet?: true | undefined
  isBraveWallet?: true | undefined
  isCoinbaseWallet?: true | undefined
  isDawn?: true | undefined
  isEnkrypt?: true | undefined
  isExodus?: true | undefined
  isFrame?: true | undefined
  isFrontier?: true | undefined
  isGamestop?: true | undefined
  isHyperPay?: true | undefined
  isImToken?: true | undefined
  isKuCoinWallet?: true | undefined
  isMathWallet?: true | undefined
  isMetaMask?: true | undefined
  isOkxWallet?: true | undefined
  isOKExWallet?: true | undefined
  isOneInchAndroidWallet?: true | undefined
  isOneInchIOSWallet?: true | undefined
  isOpera?: true | undefined
  isPhantom?: true | undefined
  isPortal?: true | undefined
  isRabby?: true | undefined
  isRainbow?: true | undefined
  isStatus?: true | undefined
  isTally?: true | undefined
  isTokenPocket?: true | undefined
  isTokenary?: true | undefined
  isTrust?: true | undefined
  isTrustWallet?: true | undefined
  isXDEFI?: true | undefined
  isZerion?: true | undefined
}

type WindowProvider = Evaluate<
  EIP1193Provider &
    WindowProviderFlags & {
      providers?: WindowProvider[] | undefined
      /** Only exists in MetaMask as of 2022/04/03 */
      _events?: { connect?: (() => void) | undefined } | undefined
      /** Only exists in MetaMask as of 2022/04/03 */
      _state?:
        | {
            accounts?: string[]
            initialized?: boolean
            isConnected?: boolean
            isPermanentlyDisconnected?: boolean
            isUnlocked?: boolean
          }
        | undefined
    }
>

type Window = {
  coinbaseWalletExtension?: WindowProvider | undefined
  ethereum?: WindowProvider | undefined
  phantom?: { ethereum: WindowProvider } | undefined
}

function findProvider(
  window: Window | undefined,
  condition:
    | keyof WindowProviderFlags
    | ((provider: WindowProvider) => boolean),
) {
  function isProvider(provider: WindowProvider) {
    if (typeof condition === 'function') return condition(provider)
    return provider[condition]
  }
  if (window?.ethereum?.providers)
    return window.ethereum.providers.find((provider) => isProvider(provider))
  if (window?.ethereum && isProvider(window.ethereum)) return window.ethereum
  return undefined
}
