/* eslint-disable */
/**
 * Recorded, read-only answers of the testnet Wrapped CSPR token
 * (hash-3d80df21…), used as token-info fixtures.
 *
 * Recorded on 2026-11-01 from https://node.testnet.casper.network/rpc (query_global_state).
 * Trimmed: merkle proofs are removed; the contract keeps the named keys and entry
 * points the scripts read. Everything else is verbatim.
 */

export const WCSPR_PACKAGE_HASH = "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e";
export const WCSPR_CONTRACT_HASH = "032706aeae170fafb6403ce3bec58062f1c4288710838fe1df98ce4ff6c35f4a";

export const wcsprPackageResponse = {
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "api_version": "2.0.0",
    "block_header": null,
    "stored_value": {
      "ContractPackage": {
        "access_key": "uref-659554eb13beadd9b969985ea4062141388cddefffb78d3a3b2b6ca2e9486257-007",
        "versions": [
          {
            "protocol_version_major": 2,
            "contract_version": 1,
            "contract_hash": "contract-58559fab21934a5e4dc8ce35de30d7efbca639e6857a14f48f886e5b62e667fd"
          },
          {
            "protocol_version_major": 2,
            "contract_version": 2,
            "contract_hash": "contract-3d9f20ec8daae1fc31429c3d229e1564b33507cdfa96cb00a958cbf74045be43"
          },
          {
            "protocol_version_major": 2,
            "contract_version": 3,
            "contract_hash": "contract-2607f840650b958bd37491bda3f1f3c626d1dba6fc683f98cb97c49c1e7d76f2"
          },
          {
            "protocol_version_major": 2,
            "contract_version": 4,
            "contract_hash": "contract-e62f9b3a416526112bbf724d949b8fb86ab494d79645f23705d126501f6d5034"
          },
          {
            "protocol_version_major": 2,
            "contract_version": 5,
            "contract_hash": "contract-99eddd6ffc58fb115caac68fad7b046adcae73b4aae7a2f1b29bb492eb96b846"
          },
          {
            "protocol_version_major": 2,
            "contract_version": 6,
            "contract_hash": "contract-4803852b2883cdb01e40df602f855e5ddddc2a8b10fe5d5b68bf47e4dcfc6b2b"
          },
          {
            "protocol_version_major": 2,
            "contract_version": 7,
            "contract_hash": "contract-4b351800391d4a47a7f932e9498516ed59bb41056d2743c14a8b1a5f90f67b3e"
          },
          {
            "protocol_version_major": 2,
            "contract_version": 8,
            "contract_hash": "contract-032706aeae170fafb6403ce3bec58062f1c4288710838fe1df98ce4ff6c35f4a"
          }
        ],
        "disabled_versions": [
          [
            2,
            1
          ],
          [
            2,
            2
          ],
          [
            2,
            3
          ],
          [
            2,
            4
          ],
          [
            2,
            5
          ],
          [
            2,
            6
          ],
          [
            2,
            7
          ]
        ],
        "groups": [
          {
            "group_name": "constructor_group",
            "group_users": []
          },
          {
            "group_name": "upgrader_group",
            "group_users": []
          }
        ],
        "lock_status": "Unlocked"
      }
    }
  }
} as const;

export const wcsprContractResponse = {
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "api_version": "2.0.0",
    "block_header": null,
    "stored_value": {
      "Contract": {
        "contract_package_hash": "contract-package-3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e",
        "contract_wasm_hash": "contract-wasm-bb4c47d02ee04346457e143e8f948ed5f1144a6ec026013de6e9baac4a4ead3b",
        "named_keys": [
          {
            "name": "allowances",
            "key": "uref-6e572af616f49d00d882439a97511a98bbc9cc92098070e174474eb0914c1d24-007"
          },
          {
            "name": "balances",
            "key": "uref-f8491246e0eed9c5cd5c0a896dc6e0a270bba846df69b6d497c9694dcdc2770c-007"
          },
          {
            "name": "chain_name",
            "key": "uref-33c19030731e8b6a1e207515dba4c0849e1baf72899d210e5dc7267bd68bc4f5-007"
          },
          {
            "name": "decimals",
            "key": "uref-14ce391a6909da5e137031207a5875929f36f23ffd8d4cf60aec0c4914c0cb7c-007"
          },
          {
            "name": "name",
            "key": "uref-95f62c9a89e31efbc3a6a92b9a6985a7b1277f36c59d45925cb9f2ebca101656-007"
          },
          {
            "name": "state",
            "key": "uref-9c58d826fb03321778a0d86c42470d58a6a8db13468ab101356108e40c7f55ba-007"
          },
          {
            "name": "symbol",
            "key": "uref-c1ae2a798fc0aa42109ad90630a5df6370ba0728bf619ad85f428bf4a43ccba5-007"
          },
          {
            "name": "total_supply",
            "key": "uref-9c1a9d240b260f928cbbadda7e9da2dd0dd77ff816ea2ea59824292bb2266256-007"
          },
          {
            "name": "used_nonces",
            "key": "uref-d02caeddd325e8b17cf3dd73e9e1efee7fc55c9d3a8a405ed8fa10c5430cc028-007"
          }
        ],
        "entry_points": [
          {
            "name": "balance_of",
            "args": [
              {
                "name": "address",
                "cl_type": "Key"
              }
            ],
            "ret": "U256",
            "access": "Public",
            "entry_point_type": "Called"
          },
          {
            "name": "deposit",
            "args": [],
            "ret": "Unit",
            "access": "Public",
            "entry_point_type": "Called"
          },
          {
            "name": "name",
            "args": [],
            "ret": "String",
            "access": "Public",
            "entry_point_type": "Called"
          },
          {
            "name": "transfer",
            "args": [
              {
                "name": "recipient",
                "cl_type": "Key"
              },
              {
                "name": "amount",
                "cl_type": "U256"
              }
            ],
            "ret": "Unit",
            "access": "Public",
            "entry_point_type": "Called"
          },
          {
            "name": "transfer_with_authorization",
            "args": [
              {
                "name": "from",
                "cl_type": "Key"
              },
              {
                "name": "to",
                "cl_type": "Key"
              },
              {
                "name": "value",
                "cl_type": "U256"
              },
              {
                "name": "valid_after",
                "cl_type": "U64"
              },
              {
                "name": "valid_before",
                "cl_type": "U64"
              },
              {
                "name": "nonce",
                "cl_type": {
                  "List": "U8"
                }
              },
              {
                "name": "public_key",
                "cl_type": "PublicKey"
              },
              {
                "name": "signature",
                "cl_type": {
                  "List": "U8"
                }
              }
            ],
            "ret": "Unit",
            "access": "Public",
            "entry_point_type": "Called"
          },
          {
            "name": "withdraw",
            "args": [
              {
                "name": "amount",
                "cl_type": "U256"
              }
            ],
            "ret": "Unit",
            "access": "Public",
            "entry_point_type": "Called"
          }
        ],
        "protocol_version": "2.2.2"
      }
    }
  }
} as const;

/** Named key URef → query_global_state answer, for name, symbol, decimals and chain_name. */
export const wcsprNamedKeyResponses = {
  "uref-95f62c9a89e31efbc3a6a92b9a6985a7b1277f36c59d45925cb9f2ebca101656-007": {
    "jsonrpc": "2.0",
    "id": 1,
    "result": {
      "api_version": "2.0.0",
      "block_header": null,
      "stored_value": {
        "CLValue": {
          "cl_type": "String",
          "bytes": "0c000000577261707065642043535052",
          "parsed": "Wrapped CSPR"
        }
      }
    }
  },
  "uref-c1ae2a798fc0aa42109ad90630a5df6370ba0728bf619ad85f428bf4a43ccba5-007": {
    "jsonrpc": "2.0",
    "id": 1,
    "result": {
      "api_version": "2.0.0",
      "block_header": null,
      "stored_value": {
        "CLValue": {
          "cl_type": "String",
          "bytes": "050000005743535052",
          "parsed": "WCSPR"
        }
      }
    }
  },
  "uref-14ce391a6909da5e137031207a5875929f36f23ffd8d4cf60aec0c4914c0cb7c-007": {
    "jsonrpc": "2.0",
    "id": 1,
    "result": {
      "api_version": "2.0.0",
      "block_header": null,
      "stored_value": {
        "CLValue": {
          "cl_type": "U8",
          "bytes": "09",
          "parsed": 9
        }
      }
    }
  },
  "uref-33c19030731e8b6a1e207515dba4c0849e1baf72899d210e5dc7267bd68bc4f5-007": {
    "jsonrpc": "2.0",
    "id": 1,
    "result": {
      "api_version": "2.0.0",
      "block_header": null,
      "stored_value": {
        "CLValue": {
          "cl_type": "String",
          "bytes": "120000006361737065723a6361737065722d74657374",
          "parsed": "casper:casper-test"
        }
      }
    }
  }
} as const;

/** WCSPR balance of the account that wrapped 1 CSPR in tx 77fb850a… (public key 0202b19435…). */
export const wcsprHolder = { publicKey: "0202b1943511b8c23b1b2b8ed7ddcedffcc7be70d9366a5005c7beab08a81b7ae633", accountHash: "0f758c10859a3dcf2a041ad3505e0e12754e66662e7e1a6d9d76af43395197a2", dictionaryAddress: "dictionary-70de0feadcde24673e572207da101f95844ce6ebf0cad4c4cf239763615ad41c" } as const;
export const wcsprHolderBalanceResponse = {
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "api_version": "2.0.0",
    "block_header": null,
    "stored_value": {
      "CLValue": {
        "cl_type": "U256",
        "bytes": "050070357d14",
        "parsed": "88000000000"
      }
    }
  }
} as const;
