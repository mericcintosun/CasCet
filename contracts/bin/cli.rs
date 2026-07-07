//! CasCet contracts deploy + interaction CLI (odra-cli / livenet).
//!
//! Deploys the on-chain layer of CasCet — currently the `ReceiptRegistry`, which
//! anchors settled x402 tool-call payments and their cascade links. Run against
//! Casper Testnet by exporting the livenet env vars (see contracts/.env.sample):
//!
//!   ODRA_CASPER_LIVENET_SECRET_KEY_PATH=/path/to/secret_key.pem
//!   ODRA_CASPER_LIVENET_NODE_ADDRESS=https://node.testnet.cspr.cloud/rpc
//!   ODRA_CASPER_LIVENET_CHAIN_NAME=casper-test
//!
//! Then: `cargo run --bin cascet_contracts_cli --features livenet -- deploy`

use cascet_contracts::receipt_registry::ReceiptRegistry;
use odra::host::{HostEnv, NoArgs};
use odra::schema::casper_contract_schema::NamedCLType;
use odra_cli::{
    deploy::DeployScript,
    scenario::{Args, Error, Scenario, ScenarioMetadata},
    CommandArg, ContractProvider, DeployedContractsContainer, DeployerExt, OdraCli,
};

/// Deploys the `ReceiptRegistry` and registers it in the deployed-contracts container.
pub struct CascetDeployScript;

impl DeployScript for CascetDeployScript {
    fn deploy(
        &self,
        env: &HostEnv,
        container: &mut DeployedContractsContainer,
    ) -> Result<(), odra_cli::deploy::Error> {
        // The deployer becomes the registry owner + first authorized recorder.
        let _registry = ReceiptRegistry::load_or_deploy(env, NoArgs, container, 500_000_000_000);
        Ok(())
    }
}

/// Anchors a demo receipt so a deployment can be verified end-to-end on-chain.
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
        let amount = args.get_single::<odra::casper_types::U256>("amount")?;

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

pub fn main() {
    OdraCli::new()
        .about("CasCet on-chain layer: deploy & interact with ReceiptRegistry")
        .deploy(CascetDeployScript)
        .contract::<ReceiptRegistry>()
        .scenario(AnchorDemoReceipt)
        .build()
        .run();
}
