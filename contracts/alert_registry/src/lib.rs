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
const CONFIG_EVT_KEY: Symbol = symbol_short!("CFG");
const PROPOSAL_EVT_KEY: Symbol = symbol_short!("PROPOSE");
const ROLE_EVT_KEY: Symbol = symbol_short!("ROLE");

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

/// Roles that can be delegated by the admin without handing over full control.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Role {
    /// May update contract configuration directly (single-admin mode only).
    ConfigManager,
}

/// Storage keys for governance state.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// `Vec<Address>` of multisig signers.
    Signers,
    /// `u32` number of approvals needed to execute a proposal.
    Threshold,
    /// `u32` id assigned to the next proposal.
    NextProposal,
    /// A pending or executed config proposal.
    Proposal(u32),
    /// Marker that `Address` holds `Role`.
    Role(Address, Role),
}

/// A multisig proposal to change a configuration parameter.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfigProposal {
    pub key: Symbol,
    pub value: String,
    pub approvals: Vec<Address>,
    pub executed: bool,
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
    InvalidThreshold = 6,
    ProposalNotFound = 7,
    AlreadyApproved = 8,
    ProposalAlreadyExecuted = 9,
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
        Self::require_admin(&env, &admin)?;
        env.storage().instance().set(&ADMIN_KEY, &new_admin);
        Ok(())
    }

    /// Updates a contract configuration parameter directly.
    ///
    /// Callable by the admin or an account holding `Role::ConfigManager`, and
    /// only while multisig governance is off (threshold of 1). Once a
    /// threshold above 1 is set, changes must go through `propose_config` /
    /// `approve_proposal`. Any other caller panics with `Error::Unauthorized`.
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

        let permitted = admin == current_admin
            || Self::has_role(env.clone(), admin.clone(), Role::ConfigManager);
        if !permitted || Self::get_threshold(env.clone()) > 1 {
            panic_with_error!(&env, Error::Unauthorized);
        }

        Self::write_config(&env, key, value);
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Role-based access control
    // -----------------------------------------------------------------------

    /// Grants `role` to `account`. Admin only.
    pub fn grant_role(env: Env, admin: Address, account: Address, role: Role) -> Result<(), Error> {
        Self::require_admin(&env, &admin)?;
        env.storage()
            .instance()
            .set(&DataKey::Role(account.clone(), role), &true);
        env.events().publish((ROLE_EVT_KEY, account), true);
        Ok(())
    }

    /// Revokes `role` from `account`. Admin only.
    pub fn revoke_role(env: Env, admin: Address, account: Address, role: Role) -> Result<(), Error> {
        Self::require_admin(&env, &admin)?;
        env.storage()
            .instance()
            .remove(&DataKey::Role(account.clone(), role));
        env.events().publish((ROLE_EVT_KEY, account), false);
        Ok(())
    }

    /// Returns whether `account` currently holds `role`.
    pub fn has_role(env: Env, account: Address, role: Role) -> bool {
        env.storage()
            .instance()
            .has(&DataKey::Role(account, role))
    }

    // -----------------------------------------------------------------------
    // Multisig governance
    // -----------------------------------------------------------------------

    /// Configures the multisig signer set and approval threshold. Admin only.
    /// A threshold of 1 keeps single-admin behaviour; above 1, configuration
    /// changes need `threshold` distinct signer approvals.
    pub fn set_signers(
        env: Env,
        admin: Address,
        signers: Vec<Address>,
        threshold: u32,
    ) -> Result<(), Error> {
        Self::require_admin(&env, &admin)?;
        if threshold == 0 || threshold > signers.len() {
            return Err(Error::InvalidThreshold);
        }
        env.storage().instance().set(&DataKey::Signers, &signers);
        env.storage().instance().set(&DataKey::Threshold, &threshold);
        Ok(())
    }

    /// Returns the multisig signers (empty when governance is single-admin).
    pub fn get_signers(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Signers)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Returns the approvals required to execute a proposal (default 1).
    pub fn get_threshold(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Threshold)
            .unwrap_or(1)
    }

    /// Opens a config-change proposal. The proposer must be a signer and
    /// counts as the first approval; the change executes immediately if the
    /// threshold is already met. Returns the proposal id.
    pub fn propose_config(
        env: Env,
        proposer: Address,
        key: Symbol,
        value: String,
    ) -> Result<u32, Error> {
        Self::require_signer(&env, &proposer);

        let id: u32 = env
            .storage()
            .instance()
            .get(&DataKey::NextProposal)
            .unwrap_or(0);
        env.storage().instance().set(&DataKey::NextProposal, &(id + 1));

        let mut approvals = Vec::new(&env);
        approvals.push_back(proposer);
        let proposal = ConfigProposal {
            key,
            value,
            approvals,
            executed: false,
        };

        env.events().publish((PROPOSAL_EVT_KEY, id), proposal.key.clone());
        Self::save_and_maybe_execute(&env, id, proposal);
        Ok(id)
    }

    /// Adds a signer's approval to a proposal, executing it once the
    /// threshold is reached.
    pub fn approve_proposal(env: Env, signer: Address, id: u32) -> Result<(), Error> {
        Self::require_signer(&env, &signer);

        let mut proposal: ConfigProposal = env
            .storage()
            .instance()
            .get(&DataKey::Proposal(id))
            .ok_or(Error::ProposalNotFound)?;
        if proposal.executed {
            return Err(Error::ProposalAlreadyExecuted);
        }
        if proposal.approvals.contains(&signer) {
            return Err(Error::AlreadyApproved);
        }

        proposal.approvals.push_back(signer);
        Self::save_and_maybe_execute(&env, id, proposal);
        Ok(())
    }

    /// Returns a proposal by id, if it exists.
    pub fn get_proposal(env: Env, id: u32) -> Option<ConfigProposal> {
        env.storage().instance().get(&DataKey::Proposal(id))
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

impl AlertRegistryContract {
    /// Authenticates `caller` and panics with `Error::Unauthorized` unless it
    /// is the current admin.
    fn require_admin(env: &Env, caller: &Address) -> Result<(), Error> {
        caller.require_auth();

        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN_KEY)
            .ok_or(Error::NotInitialized)?;
        if *caller != admin {
            panic_with_error!(env, Error::Unauthorized);
        }
        Ok(())
    }

    /// Authenticates `caller` and panics with `Error::Unauthorized` unless it
    /// is a registered multisig signer.
    fn require_signer(env: &Env, caller: &Address) {
        caller.require_auth();

        let signers: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Signers)
            .unwrap_or_else(|| Vec::new(env));
        if !signers.contains(caller) {
            panic_with_error!(env, Error::Unauthorized);
        }
    }

    fn write_config(env: &Env, key: Symbol, value: String) {
        env.storage()
            .instance()
            .set(&(CONFIG_KEY, key.clone()), &value);
        env.events().publish((CONFIG_EVT_KEY, key), value);
    }

    /// Persists the proposal, applying it if it has reached the threshold.
    fn save_and_maybe_execute(env: &Env, id: u32, mut proposal: ConfigProposal) {
        if proposal.approvals.len() >= Self::get_threshold(env.clone()) {
            Self::write_config(env, proposal.key.clone(), proposal.value.clone());
            proposal.executed = true;
        }
        env.storage().instance().set(&DataKey::Proposal(id), &proposal);
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

    fn setup(env: &Env) -> (AlertRegistryContractClient<'_>, Address) {
        let contract_id = env.register_contract(None, AlertRegistryContract);
        let client = AlertRegistryContractClient::new(env, &contract_id);
        let admin = Address::generate(env);
        client.initialize(&admin);
        (client, admin)
    }

    #[test]
    fn test_unauthorized_config_update_is_rejected_with_unauthorized() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin) = setup(&env);

        let attacker = Address::generate(&env);
        let result = client.try_update_config(
            &attacker,
            &symbol_short!("FEE"),
            &String::from_str(&env, "0"),
        );
        assert_eq!(result, Err(Ok(Error::Unauthorized)));
    }

    #[test]
    fn test_config_manager_role_can_update_and_revocation_removes_access() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let manager = Address::generate(&env);
        let key = symbol_short!("FEE");
        let val = String::from_str(&env, "25");

        assert!(!client.has_role(&manager, &Role::ConfigManager));
        client.grant_role(&admin, &manager, &Role::ConfigManager);
        assert!(client.has_role(&manager, &Role::ConfigManager));

        client.update_config(&manager, &key, &val);
        assert_eq!(client.get_config(&key), Some(val));

        client.revoke_role(&admin, &manager, &Role::ConfigManager);
        let result = client.try_update_config(&manager, &key, &String::from_str(&env, "1"));
        assert_eq!(result, Err(Ok(Error::Unauthorized)));
    }

    #[test]
    fn test_only_admin_can_grant_roles() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin) = setup(&env);

        let attacker = Address::generate(&env);
        let result = client.try_grant_role(&attacker, &attacker, &Role::ConfigManager);
        assert_eq!(result, Err(Ok(Error::Unauthorized)));
    }

    #[test]
    fn test_multisig_proposal_executes_at_threshold() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let s1 = Address::generate(&env);
        let s2 = Address::generate(&env);
        let s3 = Address::generate(&env);
        let signers = Vec::from_array(&env, [s1.clone(), s2.clone(), s3.clone()]);
        client.set_signers(&admin, &signers, &2);
        assert_eq!(client.get_threshold(), 2);

        let key = symbol_short!("FEE");
        let val = String::from_str(&env, "50");
        let id = client.propose_config(&s1, &key, &val);

        // One approval of two: not applied yet.
        assert_eq!(client.get_config(&key), None);
        assert!(!client.get_proposal(&id).unwrap().executed);

        client.approve_proposal(&s2, &id);
        assert_eq!(client.get_config(&key), Some(val));
        assert!(client.get_proposal(&id).unwrap().executed);

        // Executed proposals cannot be approved again.
        assert_eq!(
            client.try_approve_proposal(&s3, &id),
            Err(Ok(Error::ProposalAlreadyExecuted))
        );
    }

    #[test]
    fn test_multisig_rejects_duplicate_approval_and_non_signers() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let s1 = Address::generate(&env);
        let s2 = Address::generate(&env);
        client.set_signers(&admin, &Vec::from_array(&env, [s1.clone(), s2]), &2);

        let id = client.propose_config(&s1, &symbol_short!("FEE"), &String::from_str(&env, "5"));
        assert_eq!(
            client.try_approve_proposal(&s1, &id),
            Err(Ok(Error::AlreadyApproved))
        );

        let outsider = Address::generate(&env);
        assert_eq!(
            client.try_approve_proposal(&outsider, &id),
            Err(Ok(Error::Unauthorized))
        );
        assert_eq!(
            client.try_propose_config(&outsider, &symbol_short!("FEE"), &String::from_str(&env, "6")),
            Err(Ok(Error::Unauthorized))
        );
    }

    #[test]
    fn test_direct_config_update_disabled_under_multisig() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let s1 = Address::generate(&env);
        let s2 = Address::generate(&env);
        client.set_signers(&admin, &Vec::from_array(&env, [s1, s2]), &2);

        let result = client.try_update_config(
            &admin,
            &symbol_short!("FEE"),
            &String::from_str(&env, "1"),
        );
        assert_eq!(result, Err(Ok(Error::Unauthorized)));
    }

    #[test]
    fn test_set_signers_validates_threshold() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let s1 = Address::generate(&env);
        let signers = Vec::from_array(&env, [s1]);
        assert_eq!(
            client.try_set_signers(&admin, &signers, &0),
            Err(Ok(Error::InvalidThreshold))
        );
        assert_eq!(
            client.try_set_signers(&admin, &signers, &2),
            Err(Ok(Error::InvalidThreshold))
        );
    }

    #[test]
    fn test_update_config_before_initialize_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, AlertRegistryContract);
        let client = AlertRegistryContractClient::new(&env, &contract_id);

        let someone = Address::generate(&env);
        let result = client.try_update_config(
            &someone,
            &symbol_short!("FEE"),
            &String::from_str(&env, "1"),
        );
        assert_eq!(result, Err(Ok(Error::NotInitialized)));
    }
}
