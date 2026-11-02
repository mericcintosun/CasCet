/* eslint-disable */
/**
 * Recorded, read-only Casper JSON-RPC responses used as test fixtures.
 *
 * Recorded from https://node.testnet.casper.network/rpc and
 * https://node.mainnet.casper.network/rpc (query_global_state,
 * state_get_dictionary_item, info_get_transaction) on 2026-11-01 and
 * 2026-11-02. Trimmed: merkle proofs are removed and contract entry points are
 * cut down to transfer_with_authorization; everything else is verbatim.
 */

export const testnetPackageResponse = {
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "api_version": "2.0.0",
    "block_header": null,
    "stored_value": {
      "ContractPackage": {
        "access_key": "uref-65569804d7c9be96c252798dfcf9c80ab9ab1e14bea5cb967572e0f3341c8ec3-007",
        "versions": [
          {
            "protocol_version_major": 2,
            "contract_version": 1,
            "contract_hash": "contract-36e657e60199d91d9ace288e573ada1d4c1ab58b1ec6bcd31ae2c0dc62531bd8"
          }
        ],
        "disabled_versions": [],
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

/** CasCet X402 Token (legacy-amount) on testnet: the active contract of package cb65a928… */
export const testnetContractResponse = {
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "api_version": "2.0.0",
    "block_header": null,
    "stored_value": {
      "Contract": {
        "contract_package_hash": "contract-package-cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3",
        "contract_wasm_hash": "contract-wasm-b91708e3143bd503ecaab89a9f9f6e1775b54dd620d32694d031d132a5f3face",
        "named_keys": [
          {
            "name": "__events",
            "key": "uref-2f5d05f21ab29a5a24dbafc2ea6b64075f21887b2b0183af70a67b334a286b89-007"
          },
          {
            "name": "__events_ces_version",
            "key": "uref-8ae468b8321e93de8ad551d4497878137c02fa24caf50fe43972496339415bda-007"
          },
          {
            "name": "__events_length",
            "key": "uref-5c365e30fdf349c80e1e15a4152a1f1d2a4049a1f71d532d9861c8fceb8ae189-007"
          },
          {
            "name": "__events_schema",
            "key": "uref-44b9bf95b26ef5b24b728d678ba4d664b6032e3f020041b549e624bd1e9e43cd-007"
          },
          {
            "name": "allowances",
            "key": "uref-87439d8b90eff41e503c608b022414d877b78ac55c2eca44dba0f2c3a5460ce6-007"
          },
          {
            "name": "balances",
            "key": "uref-76da46a090b77721e1e54bfe35e7c91d7035b8b3cd552bf60eeeedce50d4019f-007"
          },
          {
            "name": "chain_name",
            "key": "uref-348447c32d084384417518b02b0d759456208c0d36e1f1237befaef52c8b3dd8-007"
          },
          {
            "name": "decimals",
            "key": "uref-8ff3145f14e08f8fa4ed5b0e633cda3947018af273a4042368112ebaf033f944-007"
          },
          {
            "name": "name",
            "key": "uref-6b8118c0793fe0d8ea2efabf0e56fc80c20475c3aff426517653a87deebf000d-007"
          },
          {
            "name": "state",
            "key": "uref-27cc3360e222a64eb2358dcea8205bf8ec1d1fa7b997eca73ee12561172ac201-007"
          },
          {
            "name": "symbol",
            "key": "uref-d3a3defe548f9f1df53553fc149036e83001c9b2686f688c1947ed22795627cb-007"
          },
          {
            "name": "total_supply",
            "key": "uref-285653ff9e2d921786dbf27c533d0d47220435a200ac73001c64311f123db718-007"
          },
          {
            "name": "used_nonces",
            "key": "uref-3778b4ade5131cbb24236d237bfa0ffef0c2e6d71c4c1c1ae0c5f630c234177e-007"
          }
        ],
        "entry_points": [
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
                "name": "amount",
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
          }
        ],
        "protocol_version": "2.2.2"
      }
    }
  }
} as const;

/** used_nonces item of the settled authorization in tx 04e54a95… */
export const testnetUsedNonceResponse = {
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "api_version": "2.0.0",
    "block_header": null,
    "stored_value": {
      "CLValue": {
        "cl_type": "Bool",
        "bytes": "01",
        "parsed": true
      }
    }
  }
} as const;

/** A nonce that was never used: the node answers "value was not found". */
export const testnetUnusedNonceResponse = {
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32003,
    "message": "Query failed",
    "data": "value was not found in the global state"
  }
} as const;

/** balances item of payer 6519… on testnet. */
export const testnetBalanceResponse = {
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "api_version": "2.0.0",
    "block_header": null,
    "stored_value": {
      "CLValue": {
        "cl_type": "U256",
        "bytes": "0600059b74ef5a",
        "parsed": "99984500000000"
      }
    }
  }
} as const;

/** Token `name` named key (the EIP-712 domain name) on testnet. */
export const testnetNameResponse = {
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "api_version": "2.0.0",
    "block_header": null,
    "stored_value": {
      "CLValue": {
        "cl_type": "String",
        "bytes": "11000000436173436574205834303220546f6b656e",
        "parsed": "CasCet X402 Token"
      }
    }
  }
} as const;

/** Token `chain_name` named key on testnet (the CAIP-2 network of its EIP-712 domain). */
export const testnetChainNameResponse = {
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
} as const;

export const mainnetPackageResponse = {
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "api_version": "2.0.0",
    "block_header": null,
    "stored_value": {
      "ContractPackage": {
        "access_key": "uref-c3ae319a0d500331ffac5f14101a2b7b916a50613f42c8c4dd49c0181baf2c89-007",
        "versions": [
          {
            "protocol_version_major": 2,
            "contract_version": 1,
            "contract_hash": "contract-b424e9c999a962574ad057dea0a6b8ae5c3398ee12f16b829e1bdaf6f13f58a0"
          }
        ],
        "disabled_versions": [],
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

/** CasCet X402 Token (legacy-amount) on mainnet: the active contract of package 8dd4f1aa… */
export const mainnetContractResponse = {
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "api_version": "2.0.0",
    "block_header": null,
    "stored_value": {
      "Contract": {
        "contract_package_hash": "contract-package-8dd4f1aafde3895bee3b8155f0ebb14b1c82c4effe895dfb06ea50f9bc35be41",
        "contract_wasm_hash": "contract-wasm-46450b3dc4dcf1ea2b7fac07880b2390ddb24571689e7cb12a7006b5a458bfd0",
        "named_keys": [
          {
            "name": "__events",
            "key": "uref-bdf1782d7a09e801f4dded8c5abc1214e26f3bd4b022ff3921bc5b3fd8eb30e2-007"
          },
          {
            "name": "__events_ces_version",
            "key": "uref-142d46462433730461b9ca76f8772681033058aeb1cda2c28a9e4eef0ad2c732-007"
          },
          {
            "name": "__events_length",
            "key": "uref-8309ae46e3440588bd436647db562de8cd41400f3d543c55d6409897e89a38db-007"
          },
          {
            "name": "__events_schema",
            "key": "uref-6eed106ac78ce0451c8b46d8327d4ae4414fd64f5e6a699766c125e3f6093ab0-007"
          },
          {
            "name": "allowances",
            "key": "uref-1bbc1ef5d6541e5fc6a8ce84c6c6308f1e4630daf2e92bcbcbea29d2f0b6ee15-007"
          },
          {
            "name": "balances",
            "key": "uref-dce587b513cd7bb91057b5a8d17b1508f4a4f9c50409c2951cb786e0d91803aa-007"
          },
          {
            "name": "chain_name",
            "key": "uref-7c93dbbb34c806c93940e0cae9af6531d7b2d0c0b327d844ee96b6a961424360-007"
          },
          {
            "name": "decimals",
            "key": "uref-88ec32fca64c6bdb21b9c4deca99a899ce53a576fa8127599a06f3711bbfc760-007"
          },
          {
            "name": "name",
            "key": "uref-e2b604e2d8244db66fa8935ca1cdfcb6d573957da737e0ace9b5af3fdd7509c3-007"
          },
          {
            "name": "state",
            "key": "uref-a7e7a452c60ec2ef0284f2ab7ce73dd37f906bbafe92cb25cfa7af61d9e06adc-007"
          },
          {
            "name": "symbol",
            "key": "uref-7abb06ef1fda17c63ca8c710f34d00cf699103c60e5c55f8621f5fc6b8fa7e68-007"
          },
          {
            "name": "total_supply",
            "key": "uref-7385136705d71febe1c0e28f2d6a3e5d31c16f316b5cddb5f0a16517d47d76a1-007"
          },
          {
            "name": "used_nonces",
            "key": "uref-a040188ea26493e66b91f99b2789f93d1dac380112520cbb1cd60bd1ca872d20-007"
          }
        ],
        "entry_points": [
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
                "name": "amount",
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
          }
        ],
        "protocol_version": "2.2.2"
      }
    }
  }
} as const;

/** used_nonces item of the settled authorization in mainnet tx 2c66141c… */
export const mainnetUsedNonceResponse = {
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "api_version": "2.0.0",
    "block_header": null,
    "stored_value": {
      "CLValue": {
        "cl_type": "Bool",
        "bytes": "01",
        "parsed": true
      }
    }
  }
} as const;

/** Dictionary writes of settled testnet transaction 04e54a95… (built by casper-x402 1.0.0). */
export const testnetSettledWrites = {
  "usedNonceWrite": {
    "key": "dictionary-277352b4a03fcca0ff1e5eb6e534de8db013216692287fb7b13a9372f60f05fc",
    "kind": {
      "Write": {
        "CLValue": {
          "cl_type": "Any",
          "bytes": "010000000100200000003778b4ade5131cbb24236d237bfa0ffef0c2e6d71c4c1c1ae0c5f630c234177e4000000066356135333637653562653336386337396236396239643535373564353836646337653138316135643863633637383834386464316535306437303363336432",
          "parsed": null
        }
      }
    }
  },
  "balanceWrite": {
    "key": "dictionary-cd0755e184eb134c863b1a865098080f0c339b34fd832dd3c17a7bad86d59b42",
    "kind": {
      "Write": {
        "CLValue": {
          "cl_type": "Any",
          "bytes": "070000000600f7a09ef05a072000000076da46a090b77721e1e54bfe35e7c91d7035b8b3cd552bf60eeeedce50d4019f2c0000004147555a415361787969677642422b7461335334526150456a67794545546b7245385a416f576f554f507235",
          "parsed": null
        }
      }
    }
  }
} as const;

/** from / nonce args of settled mainnet tx 2c66141c… (its nonce reads back as used). */
export const mainnetSettledArgs = {
  "from": "0065190126b1ca282f041fad6b74b845a3c48e0c8411392b13c640a16a1438faf9",
  "nonce": "2000000013d8ff4253e3578cba389b52fafdaa659dacba5162dbfb12dcf734d6df6cc76a"
} as const;

export const noSuchTransactionResponse = {
  jsonrpc: "2.0",
  id: 1,
  error: { code: -32014, message: "No such transaction", data: "no transaction for hash transaction-v1-hash(0000..00aa)" },
} as const;

/** Official Wrapped CSPR (cep3009-value) on testnet: eight versions, the first seven disabled ([major, version] pairs). */
export const wcsprTestnetPackageResponse = {
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

/** Wrapped CSPR on testnet: active contract version 8. */
export const wcsprTestnetContractResponse = {
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
            "name": "__contract_main_purse",
            "key": "uref-fc2dd45fdece06502f19c86aff89850d973076cf31ca18c284e5e96bc5c0d2eb-007"
          },
          {
            "name": "__events",
            "key": "uref-a36c312ec15b673dc4399eec65ec2b4d7877971cf5d3805b653b046dd7be751c-007"
          },
          {
            "name": "__events_ces_version",
            "key": "uref-38116691bf9e77728fee42dae20a48a3c224452e659d191a6b04e766fd6f2f1e-007"
          },
          {
            "name": "__events_length",
            "key": "uref-63e5d220391d529888c8016537a0872fbe389a0bb6e366e067bcaef37bea5d66-007"
          },
          {
            "name": "__events_schema",
            "key": "uref-b7bdfce47f012cb8704d46a4a25c3bacacb8678b41b69e0860d46d789f7d7b2a-007"
          },
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
          }
        ],
        "protocol_version": "2.2.2"
      }
    }
  }
} as const;

/** Wrapped CSPR `name` named key on testnet. */
export const wcsprTestnetNameResponse = {
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
} as const;

/** Wrapped CSPR `chain_name` named key on testnet. */
export const wcsprTestnetChainNameResponse = {
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
} as const;

/** state_get_dictionary_item for a dictionary the contract does not have (`authorization_state` on CasCet's testnet token). */
export const dictionaryURefNotFoundResponse = {
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32018,
    "message": "Node request failure",
    "data": "request for dictionary item has failed: dictionary URef not found"
  }
} as const;
