//! CasCet contracts deploy + interaction CLI (odra-cli / livenet).
//!
//! Deploys the on-chain layer of CasCet:
//!   - ReceiptRegistry — anchors settled tool-call payments + cascade links.
//!   - Cep18           — a demo CEP-18 payment token (WCSPR), supply to deployer.
//!   - RevenueSplit    — splits that token's revenue 60/40 between the deployer
//!                       and the buildathon account, enforced on-chain.
//!
//! Run against Casper Testnet with contracts/.env populated (see .env.sample):
//!   cargo run --bin cascet_contracts_cli -- deploy
//!   cargo run --bin cascet_contracts_cli -- scenario fund-split --amount 1000000000000
//!   cargo run --bin cascet_contracts_cli -- scenario release --payee <public-key-hex>

use core::str::FromStr;

use cascet_contracts::cascade_controller::CascadeController;
use cascet_contracts::receipt_registry::ReceiptRegistry;
use cascet_contracts::revenue_split::{RevenueSplit, RevenueSplitInitArgs};
use odra::casper_types::U256;
use odra::host::{HostEnv, NoArgs};
use odra::prelude::{Address, Addressable};
use odra::schema::casper_contract_schema::NamedCLType;
use cascet_contracts::demo_token::{DemoToken, DemoTokenInitArgs};
use odra_cli::{
    deploy::DeployScript,
    scenario::{Args, Error, Scenario, ScenarioMetadata},
    CommandArg, ContractProvider, DeployedContractsContainer, DeployerExt, OdraCli,
};

/// The buildathon account (account hash of public key 0203865a…) — second
/// revenue-split payee (40%).
const PAYEE2_ACCOUNT: &str =
    "account-hash-a88a12ab6f3f7942ec3f9ddcc4c5fcc552a535604942f46cf712ddcdb40f903f";

/// Deploys ReceiptRegistry, a demo CEP-18 token, and a RevenueSplit over it.
pub struct CascetDeployScript;

impl DeployScript for CascetDeployScript {
    fn deploy(
        &self,
        env: &HostEnv,
        container: &mut DeployedContractsContainer,
    ) -> Result<(), odra_cli::deploy::Error> {
        // Already deployed earlier — load_or_deploy just loads it from the container.
        let _registry = ReceiptRegistry::load_or_deploy(env, NoArgs, container, 500_000_000_000)?;

        // Demo payment token: 1,000,000 WCSPR (9 decimals) minted to the deployer.
        let token = DemoToken::load_or_deploy(
            env,
            DemoTokenInitArgs {
                symbol: "WCSPR".to_string(),
                name: "Wrapped CSPR (CasCet demo)".to_string(),
                decimals: 9,
                initial_supply: U256::from(1_000_000u64) * U256::from(1_000_000_000u64),
            },
            container,
            400_000_000_000,
        )?;

        // 60% deployer, 40% buildathon account — enforced on-chain.
        let deployer = env.caller();
        let payee2 = Address::from_str(PAYEE2_ACCOUNT).expect("valid payee account hash");
        let _split = RevenueSplit::load_or_deploy(
            env,
            RevenueSplitInitArgs {
                token: token.address(),
                payees: vec![deployer, payee2],
                shares: vec![60, 40],
            },
            container,
            500_000_000_000,
        )?;
        Ok(())
    }
}

/// Transfers demo CEP-18 tokens from the deployer into the RevenueSplit contract
/// (simulates a server earning revenue), so shares become releasable.
pub struct FundSplit;

impl Scenario for FundSplit {
    fn args(&self) -> Vec<CommandArg> {
        vec![CommandArg::new("amount", "Raw CEP-18 units to send to the splitter", NamedCLType::U256)]
    }

    fn run(&self, env: &HostEnv, container: &DeployedContractsContainer, args: Args) -> Result<(), Error> {
        let mut token = container.contract_ref::<DemoToken>(env)?;
        let split = container.contract_ref::<RevenueSplit>(env)?;
        let amount = args.get_single::<U256>("amount")?;
        env.set_gas(5_000_000_000);
        token.try_transfer(split.address(), amount)?;
        Ok(())
    }
}

impl ScenarioMetadata for FundSplit {
    const NAME: &'static str = "fund-split";
    const DESCRIPTION: &'static str = "Send CEP-18 revenue into the RevenueSplit contract";
}

/// Releases a payee's outstanding share out of the RevenueSplit contract.
pub struct ReleaseShare;

impl Scenario for ReleaseShare {
    fn args(&self) -> Vec<CommandArg> {
        vec![CommandArg::new("payee", "Payee account-hash string (defaults to caller)", NamedCLType::String)]
    }

    fn run(&self, env: &HostEnv, container: &DeployedContractsContainer, args: Args) -> Result<(), Error> {
        let mut split = container.contract_ref::<RevenueSplit>(env)?;
        let payee_str = args.get_single::<String>("payee").unwrap_or_default();
        let payee = if payee_str.is_empty() {
            env.caller()
        } else {
            Address::from_str(&payee_str)
                .map_err(|_| Error::OdraError { message: "bad payee account hash".into() })?
        };
        env.set_gas(5_000_000_000);
        split.try_release(payee)?;
        Ok(())
    }
}

impl ScenarioMetadata for ReleaseShare {
    const NAME: &'static str = "release";
    const DESCRIPTION: &'static str = "Release a payee's share from the RevenueSplit contract";
}

/// Anchors a demo receipt directly (used to verify the deployed registry).
pub struct AnchorDemoReceipt;

impl Scenario for AnchorDemoReceipt {
    fn args(&self) -> Vec<CommandArg> {
        vec![
            CommandArg::new("payment_id", "Unique payment id to anchor", NamedCLType::String),
            CommandArg::new("amount", "Raw CEP-18 token units", NamedCLType::U256),
        ]
    }

    fn run(&self, env: &HostEnv, container: &DeployedContractsContainer, args: Args) -> Result<(), Error> {
        let mut registry = container.contract_ref::<ReceiptRegistry>(env)?;
        let payment_id = args.get_single::<String>("payment_id")?;
        let amount = args.get_single::<U256>("amount")?;
        env.set_gas(5_000_000_000);
        registry.try_record(
            payment_id,
            String::new(),
            "demo-payer".to_string(),
            "demo-payee".to_string(),
            amount,
            "casper-defi-data".to_string(),
            "get_cspr_market_data".to_string(),
            "demo-tx".to_string(),
        )?;
        Ok(())
    }
}

impl ScenarioMetadata for AnchorDemoReceipt {
    const NAME: &'static str = "anchor-demo";
    const DESCRIPTION: &'static str = "Anchor a demo receipt to verify the deployed registry works";
}

fn parse_addr(s: &str) -> Result<Address, Error> {
    Address::from_str(s).map_err(|_| Error::OdraError { message: format!("bad address: {s}") })
}

/// Opens a budget-bounded cascade (agent deposits, delegates to an operator).
pub struct CascadeOpen;
impl Scenario for CascadeOpen {
    fn args(&self) -> Vec<CommandArg> {
        vec![
            CommandArg::new("operator", "Operator account-hash allowed to charge", NamedCLType::String),
            CommandArg::new("token", "CEP-18 token package hash (hash-...)", NamedCLType::String),
            CommandArg::new("budget", "Total budget in raw token units", NamedCLType::U256),
        ]
    }
    fn run(&self, env: &HostEnv, container: &DeployedContractsContainer, args: Args) -> Result<(), Error> {
        let mut c = container.contract_ref::<CascadeController>(env)?;
        let operator = parse_addr(&args.get_single::<String>("operator")?)?;
        let token = parse_addr(&args.get_single::<String>("token")?)?;
        let budget = args.get_single::<U256>("budget")?;
        env.set_gas(6_000_000_000);
        c.try_open(operator, token, budget)?;
        Ok(())
    }
}
impl ScenarioMetadata for CascadeOpen {
    const NAME: &'static str = "cascade-open";
    const DESCRIPTION: &'static str = "Open a budget-bounded cascade";
}

/// Charges a hop against a cascade (operator only), with optional attribution up.
pub struct CascadeCharge;
impl Scenario for CascadeCharge {
    fn args(&self) -> Vec<CommandArg> {
        vec![
            CommandArg::new("cascade_id", "Cascade id", NamedCLType::U64),
            CommandArg::new("parent", "Parent hop id (0 for root)", NamedCLType::U64),
            CommandArg::new("payee", "Payee account-hash", NamedCLType::String),
            CommandArg::new("gross", "Gross amount in raw units", NamedCLType::U256),
            CommandArg::new("attribution_bps", "Basis points redirected to parent (0-10000)", NamedCLType::U64),
        ]
    }
    fn run(&self, env: &HostEnv, container: &DeployedContractsContainer, args: Args) -> Result<(), Error> {
        let mut c = container.contract_ref::<CascadeController>(env)?;
        let cascade_id = args.get_single::<u64>("cascade_id")?;
        let parent = args.get_single::<u64>("parent")?;
        let payee = parse_addr(&args.get_single::<String>("payee")?)?;
        let gross = args.get_single::<U256>("gross")?;
        let bps = args.get_single::<u64>("attribution_bps")?;
        env.set_gas(6_000_000_000);
        c.try_charge(cascade_id, parent, payee, gross, bps)?;
        Ok(())
    }
}
impl ScenarioMetadata for CascadeCharge {
    const NAME: &'static str = "cascade-charge";
    const DESCRIPTION: &'static str = "Charge a hop against a cascade budget";
}

/// Owner closes a cascade and reclaims the remainder.
pub struct CascadeCloseCmd;
impl Scenario for CascadeCloseCmd {
    fn args(&self) -> Vec<CommandArg> {
        vec![CommandArg::new("cascade_id", "Cascade id", NamedCLType::U64)]
    }
    fn run(&self, env: &HostEnv, container: &DeployedContractsContainer, args: Args) -> Result<(), Error> {
        let mut c = container.contract_ref::<CascadeController>(env)?;
        let cascade_id = args.get_single::<u64>("cascade_id")?;
        env.set_gas(6_000_000_000);
        c.try_close(cascade_id)?;
        Ok(())
    }
}
impl ScenarioMetadata for CascadeCloseCmd {
    const NAME: &'static str = "cascade-close";
    const DESCRIPTION: &'static str = "Close a cascade and reclaim the remainder";
}

pub fn main() {
    OdraCli::new()
        .about("CasCet on-chain layer: ReceiptRegistry + CEP-18 + RevenueSplit + CascadeController")
        .deploy(CascetDeployScript)
        .contract::<ReceiptRegistry>()
        .contract::<DemoToken>()
        .contract::<RevenueSplit>()
        .contract::<CascadeController>()
        .scenario(AnchorDemoReceipt)
        .scenario(FundSplit)
        .scenario(ReleaseShare)
        .scenario(CascadeOpen)
        .scenario(CascadeCharge)
        .scenario(CascadeCloseCmd)
        .build()
        .run();
}
