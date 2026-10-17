# ⚡ Stellar Alerts — Soroban On-Chain Alert Registry Contract

This directory contains the **Soroban Wasm Smart Contract** for Stellar Alerts.

It enables decentralized applications (dApps) and individual Stellar accounts to programmatically register payment alert listeners directly on the Stellar blockchain.

---

## 🏗️ Smart Contract API Specification

### 1. `register_listener(user: Address, channel: Symbol, target: String)`
Registers an alert listener preference for `user` on channel (e.g. `symbol_short!("telegram")`, `symbol_short!("email")`, or `symbol_short!("webhook")`).
Requires authentication from `user`. Publishes a `REGISTERED` event on-chain for off-chain ingestion watchers.

### 2. `get_listener(user: Address, channel: Symbol) -> Option<String>`
Queries stored target string (e.g. Telegram Chat ID, Email Address, or Webhook URL) for a given account.

### 3. `register_wallet(user: Address, wallet: Address)`
Registers a Stellar wallet address under `user` so it can be referenced by an alert subscription. Requires authentication from `user`. Idempotent — registering the same wallet twice does not duplicate it. Publishes a `WALREG` event.

### 4. `get_wallets(user: Address) -> Vec<Address>`
Returns every wallet `user` has registered (empty vector if none).

### 5. `subscribe(user: Address, subscription: AlertSubscription) -> Result<(), Error>`
Creates or updates an alert subscription binding a registered wallet to a delivery channel and target (e.g. a Discord/Slack webhook URL). Requires authentication from `user`. Fails with `Error::WalletNotRegistered` if `subscription.wallet` was not previously registered via `register_wallet`. Publishes a `SUB` event.

`AlertSubscription` fields: `wallet: Address`, `channel: Symbol`, `target: String`, `active: bool`.

### 6. `unsubscribe(user: Address, wallet: Address, channel: Symbol) -> Result<(), Error>`
Removes a wallet's alert subscription for the given channel. Requires authentication from `user`. Fails with `Error::SubscriptionNotFound` if no such subscription exists. Publishes an `UNSUB` event.

### 7. `get_subscription(user: Address, wallet: Address, channel: Symbol) -> Option<AlertSubscription>`
Queries a wallet's alert subscription for a given channel.

---

## 🛠️ How to Compile & Deploy Locally

### Prerequisites
- **Rust Toolchain**: [rustup.rs](https://rustup.rs) with WASM target:
  ```bash
  rustup target add wasm32-unknown-unknown
  ```
- **Soroban CLI**:
  ```bash
  cargo install --locked soroban-cli
  ```

### Build WASM Binary
```bash
cargo build --target wasm32-unknown-unknown --release
```

### Deploy to Stellar Testnet
```bash
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/stellar_alerts_registry.wasm \
  --source <YOUR_STELLAR_TESTNET_SECRET_KEY> \
  --network testnet
```
