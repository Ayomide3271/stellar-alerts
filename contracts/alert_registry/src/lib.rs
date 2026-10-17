#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    Env, String, Symbol, Vec,
};

const REGISTRATION_KEY: Symbol = symbol_short!("REGISTERED");
const ADMIN_KEY: Symbol = symbol_short!("ADMIN");
const CONFIG_KEY: Symbol = symbol_short!("CONFIG");
const WALLETS_KEY: Symbol = symbol_short!("WALLETS");
const SUBS_KEY: Symbol = symbol_short!("SUBS");
const WALLET_REG_KEY: Symbol = symbol_short!("WALREG");
const SUB_EVT_KEY: Symbol = symbol_short!("SUB");
const UNSUB_EVT_KEY: Symbol = symbol_short!("UNSUB");

/// An alert subscription binding a registered wallet to a delivery channel
/// (e.g. "discord", "slack", "telegram", "webhook") and its target.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AlertSubscription {
    pub wallet: Address,
    pub channel: Symbol,
    pub target: String,
    pub active: bool,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    Unauthorized = 1,
    AlreadyInitialized = 2,
    NotInitialized = 3,
    WalletNotRegistered = 4,
    SubscriptionNotFound = 5,
}

#[contract]
pub struct AlertRegistryContract;

#[contractimpl]
impl AlertRegistryContract {
    /// Initializes the contract with an admin governance address.
    pub fn initialize(env: Env, admin: Address) -> Result<(), Error> {
        if env.storage().instance().has(&ADMIN_KEY) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&ADMIN_KEY, &admin);
        Ok(())
    }

    /// Returns the current registered admin address if set.
    pub fn get_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&ADMIN_KEY)
    }

    /// Updates the admin governance address. Only authorized by the current admin.
    pub fn set_admin(env: Env, admin: Address, new_admin: Address) -> Result<(), Error> {
        admin.require_auth();

        let current_admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN_KEY)
            .ok_or(Error::NotInitialized)?;

        if admin != current_admin {
            panic_with_error!(&env, Error::Unauthorized);
        }

        env.storage().instance().set(&ADMIN_KEY, &new_admin);
        Ok(())
    }

    /// Updates a contract configuration parameter (admin governance).
    pub fn update_config(
        env: Env,
        admin: Address,
        key: Symbol,
        value: String,
    ) -> Result<(), Error> {
        admin.require_auth();

        let current_admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN_KEY)
            .ok_or(Error::NotInitialized)?;

        if admin != current_admin {
            panic_with_error!(&env, Error::Unauthorized);
        }

        env.storage().instance().set(&(CONFIG_KEY, key), &value);
        Ok(())
    }

    /// Retrieves a contract configuration parameter by symbol key.
    pub fn get_config(env: Env, key: Symbol) -> Option<String> {
        env.storage().instance().get(&(CONFIG_KEY, key))
    }

    /// Registers an alert listener preference on-chain for a user address.
    pub fn register_listener(env: Env, user: Address, channel: Symbol, target: String) {
        user.require_auth();

        // Store user preference in instance storage
        env.storage().instance().set(&(user.clone(), channel.clone()), &target);

        // Publish event for off-chain ingestion watchers
        env.events().publish((REGISTRATION_KEY, user, channel), target);
    }

    /// Queries the registered alert target for a given user and channel.
    pub fn get_listener(env: Env, user: Address, channel: Symbol) -> Option<String> {
        env.storage().instance().get(&(user, channel))
    }

    /// Registers a Stellar wallet address for a user, so it can later be
    /// referenced by an alert subscription. Idempotent: registering the same
    /// wallet twice does not create a duplicate entry.
    pub fn register_wallet(env: Env, user: Address, wallet: Address) {
        user.require_auth();

        let mut wallets = Self::get_wallets(env.clone(), user.clone());
        if !wallets.contains(&wallet) {
            wallets.push_back(wallet.clone());
            env.storage()
                .instance()
                .set(&(WALLETS_KEY, user.clone()), &wallets);
        }

        env.events()
            .publish((WALLET_REG_KEY, user), wallet);
    }

    /// Returns all wallets a user has registered, or an empty vector if none.
    pub fn get_wallets(env: Env, user: Address) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&(WALLETS_KEY, user))
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Creates or updates an alert subscription for a wallet the user has
    /// already registered via `register_wallet`. Fails with
    /// `Error::WalletNotRegistered` if the wallet is unknown to this user.
    pub fn subscribe(
        env: Env,
        user: Address,
        subscription: AlertSubscription,
    ) -> Result<(), Error> {
        user.require_auth();

        let wallets = Self::get_wallets(env.clone(), user.clone());
        if !wallets.contains(&subscription.wallet) {
            return Err(Error::WalletNotRegistered);
        }

        env.storage().instance().set(
            &(SUBS_KEY, user.clone(), subscription.wallet.clone(), subscription.channel.clone()),
            &subscription,
        );

        env.events().publish(
            (SUB_EVT_KEY, user, subscription.wallet.clone()),
            subscription.channel.clone(),
        );

        Ok(())
    }

    /// Removes a wallet's alert subscription for a given channel.
    pub fn unsubscribe(
        env: Env,
        user: Address,
        wallet: Address,
        channel: Symbol,
    ) -> Result<(), Error> {
        user.require_auth();

        let key = (SUBS_KEY, user.clone(), wallet.clone(), channel.clone());
        if !env.storage().instance().has(&key) {
            return Err(Error::SubscriptionNotFound);
        }
        env.storage().instance().remove(&key);

        env.events().publish((UNSUB_EVT_KEY, user, wallet), channel);

        Ok(())
    }

    /// Retrieves a wallet's alert subscription for a given channel, if any.
    pub fn get_subscription(
        env: Env,
        user: Address,
        wallet: Address,
        channel: Symbol,
    ) -> Option<AlertSubscription> {
        env.storage().instance().get(&(SUBS_KEY, user, wallet, channel))
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    #[test]
    fn test_initialize_and_admin_governance() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, AlertRegistryContract);
        let client = AlertRegistryContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let new_admin = Address::generate(&env);

        // Initialize contract with admin
        client.initialize(&admin);
        assert_eq!(client.get_admin(), Some(admin.clone()));

        // Update admin as authorized admin
        client.set_admin(&admin, &new_admin);
        assert_eq!(client.get_admin(), Some(new_admin));
    }

    #[test]
    fn test_admin_config_update() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, AlertRegistryContract);
        let client = AlertRegistryContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        client.initialize(&admin);

        let key = symbol_short!("FEE");
        let val = String::from_str(&env, "10");

        client.update_config(&admin, &key, &val);
        assert_eq!(client.get_config(&key), Some(val));
    }

    #[test]
    fn test_register_and_get_listener() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, AlertRegistryContract);
        let client = AlertRegistryContractClient::new(&env, &contract_id);

        let user = Address::generate(&env);
        let channel = symbol_short!("DISCORD");
        let target = String::from_str(&env, "https://discord.com/webhook/123");

        client.register_listener(&user, &channel, &target);
        assert_eq!(client.get_listener(&user, &channel), Some(target));
    }

    #[test]
    #[should_panic]
    fn test_unauthorized_admin_update_panics() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, AlertRegistryContract);
        let client = AlertRegistryContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let attacker = Address::generate(&env);

        client.initialize(&admin);

        // Attacker attempts to update admin (must panic with Error::Unauthorized)
        client.set_admin(&attacker, &attacker);
    }

    #[test]
    fn test_register_wallet_and_list() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, AlertRegistryContract);
        let client = AlertRegistryContractClient::new(&env, &contract_id);

        let user = Address::generate(&env);
        let wallet_a = Address::generate(&env);
        let wallet_b = Address::generate(&env);

        client.register_wallet(&user, &wallet_a);
        client.register_wallet(&user, &wallet_b);
        // Re-registering the same wallet is idempotent.
        client.register_wallet(&user, &wallet_a);

        let wallets = client.get_wallets(&user);
        assert_eq!(wallets.len(), 2);
        assert!(wallets.contains(&wallet_a));
        assert!(wallets.contains(&wallet_b));
    }

    #[test]
    fn test_subscribe_and_get_subscription() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, AlertRegistryContract);
        let client = AlertRegistryContractClient::new(&env, &contract_id);

        let user = Address::generate(&env);
        let wallet = Address::generate(&env);
        client.register_wallet(&user, &wallet);

        let channel = symbol_short!("DISCORD");
        let target = String::from_str(&env, "https://discord.com/webhook/123");
        let subscription = AlertSubscription {
            wallet: wallet.clone(),
            channel: channel.clone(),
            target: target.clone(),
            active: true,
        };

        client.subscribe(&user, &subscription);

        let stored = client.get_subscription(&user, &wallet, &channel);
        assert_eq!(stored, Some(subscription));
    }

    #[test]
    fn test_subscribe_without_registered_wallet_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, AlertRegistryContract);
        let client = AlertRegistryContractClient::new(&env, &contract_id);

        let user = Address::generate(&env);
        let unregistered_wallet = Address::generate(&env);
        let subscription = AlertSubscription {
            wallet: unregistered_wallet,
            channel: symbol_short!("SLACK"),
            target: String::from_str(&env, "https://hooks.slack.com/services/x"),
            active: true,
        };

        let result = client.try_subscribe(&user, &subscription);
        assert_eq!(result, Err(Ok(Error::WalletNotRegistered)));
    }

    #[test]
    fn test_unsubscribe_removes_subscription() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, AlertRegistryContract);
        let client = AlertRegistryContractClient::new(&env, &contract_id);

        let user = Address::generate(&env);
        let wallet = Address::generate(&env);
        client.register_wallet(&user, &wallet);

        let channel = symbol_short!("DISCORD");
        let subscription = AlertSubscription {
            wallet: wallet.clone(),
            channel: channel.clone(),
            target: String::from_str(&env, "https://discord.com/webhook/123"),
            active: true,
        };
        client.subscribe(&user, &subscription);

        client.unsubscribe(&user, &wallet, &channel);
        assert_eq!(client.get_subscription(&user, &wallet, &channel), None);
    }

    #[test]
    #[should_panic]
    fn test_unauthorized_register_wallet_panics() {
        let env = Env::default();
        // Auths are NOT mocked here: require_auth() must panic without them.
        let contract_id = env.register_contract(None, AlertRegistryContract);
        let client = AlertRegistryContractClient::new(&env, &contract_id);

        let user = Address::generate(&env);
        let wallet = Address::generate(&env);

        client.register_wallet(&user, &wallet);
    }
}
