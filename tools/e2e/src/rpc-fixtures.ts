/* eslint-disable */
/**
 * Recorded, read-only Casper JSON-RPC responses used as test fixtures.
 *
 * Recorded on 2026-11-01 and 2026-11-02 from https://node.testnet.casper.network/rpc
 * and https://node.mainnet.casper.network/rpc (query_global_state,
 * info_get_transaction). Trimmed: merkle proofs and transaction effects are
 * removed, and contract entry points are cut down to transfer_with_authorization;
 * everything else is verbatim. The token contracts and named keys are the same
 * recordings as packages/gateway/src/testing/rpc-fixtures.ts.
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

/** Settled testnet transfer_with_authorization tx 04e54a95… (built by casper-x402 1.0.0). */
export const testnetSettledTransaction = {
  "hash": "04e54a95979152f653bcab15bd999fc7ef897e783f9cafd095ebad06353b6c76",
  "payload": {
    "initiator_addr": {
      "PublicKey": "01dd710d5083920b20c706a92d742c7bf9162d09c96fa373bd0a67b0bf51d3f183"
    },
    "timestamp": "2026-07-22T21:07:38.221Z",
    "ttl": "30m",
    "chain_name": "casper-test",
    "pricing_mode": {
      "PaymentLimited": {
        "payment_amount": 7000000000,
        "gas_price_tolerance": 1,
        "standard_payment": true
      }
    },
    "fields": {
      "args": {
        "Named": [
          [
            "from",
            {
              "cl_type": "Key",
              "bytes": "0065190126b1ca282f041fad6b74b845a3c48e0c8411392b13c640a16a1438faf9",
              "parsed": "account-hash-65190126b1ca282f041fad6b74b845a3c48e0c8411392b13c640a16a1438faf9"
            }
          ],
          [
            "to",
            {
              "cl_type": "Key",
              "bytes": "00881cae32337ce2986bbdc8d391f88242af0f3626a14c62bbe050f7bb64f63f36",
              "parsed": "account-hash-881cae32337ce2986bbdc8d391f88242af0f3626a14c62bbe050f7bb64f63f36"
            }
          ],
          [
            "amount",
            {
              "cl_type": "U256",
              "bytes": "040065cd1d",
              "parsed": "500000000"
            }
          ],
          [
            "valid_after",
            {
              "cl_type": "U64",
              "bytes": "c22e616a00000000",
              "parsed": 1784753858
            }
          ],
          [
            "valid_before",
            {
              "cl_type": "U64",
              "bytes": "4632616a00000000",
              "parsed": 1784754758
            }
          ],
          [
            "nonce",
            {
              "cl_type": {
                "List": "U8"
              },
              "bytes": "200000009c58f1e5a21d9fd85dc46828cee8828e1726da30c2ece9421c3098c281ea5ee2",
              "parsed": [
                156,
                88,
                241,
                229,
                162,
                29,
                159,
                216,
                93,
                196,
                104,
                40,
                206,
                232,
                130,
                142,
                23,
                38,
                218,
                48,
                194,
                236,
                233,
                66,
                28,
                48,
                152,
                194,
                129,
                234,
                94,
                226
              ]
            }
          ],
          [
            "public_key",
            {
              "cl_type": "PublicKey",
              "bytes": "01f878979ff462b7d502daa34893f045cb539d2d78fb9c02f0e1a65ceebe2f8db2",
              "parsed": "01f878979ff462b7d502daa34893f045cb539d2d78fb9c02f0e1a65ceebe2f8db2"
            }
          ],
          [
            "signature",
            {
              "cl_type": {
                "List": "U8"
              },
              "bytes": "4100000001cbb603be21c10487ead6a61ab918dea4197e5bb0f57815325301994e3d7e1d0473db805a8427d98c62c3e93830930d622403b00bc346c2bc4ff2820bdf09a604",
              "parsed": [
                1,
                203,
                182,
                3,
                190,
                33,
                193,
                4,
                135,
                234,
                214,
                166,
                26,
                185,
                24,
                222,
                164,
                25,
                126,
                91,
                176,
                245,
                120,
                21,
                50,
                83,
                1,
                153,
                78,
                61,
                126,
                29,
                4,
                115,
                219,
                128,
                90,
                132,
                39,
                217,
                140,
                98,
                195,
                233,
                56,
                48,
                147,
                13,
                98,
                36,
                3,
                176,
                11,
                195,
                70,
                194,
                188,
                79,
                242,
                130,
                11,
                223,
                9,
                166,
                4
              ]
            }
          ]
        ]
      },
      "entry_point": {
        "Custom": "transfer_with_authorization"
      },
      "scheduling": "Standard",
      "target": {
        "Stored": {
          "id": {
            "ByPackageHash": {
              "addr": "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3",
              "version": null
            }
          },
          "runtime": "VmCasperV1"
        }
      }
    }
  },
  "approvals": [
    {
      "signer": "01dd710d5083920b20c706a92d742c7bf9162d09c96fa373bd0a67b0bf51d3f183",
      "signature": "01d05aa7e87da82d0966d689912c4d3ce81e172c8f50edd1317d707eae22f7a308802c4bd323a3f7a2debc7ae2aca6d171d84c9e526307c7067c9923353ee82f02"
    }
  ],
  "execution_info": {
    "block_hash": "6463899ed778e14e325892541331dee54de63ea2a5d698d2a861a64bda4f33e9",
    "block_height": 8591707,
    "execution_result": {
      "Version2": {
        "initiator": {
          "PublicKey": "01dd710d5083920b20c706a92d742c7bf9162d09c96fa373bd0a67b0bf51d3f183"
        },
        "error_message": null,
        "current_price": 1,
        "limit": "7000000000",
        "consumed": "2706561290",
        "cost": "7000000000",
        "refund": "3220079032",
        "size_estimate": 892
      }
    }
  },
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

export const noSuchTransactionResponse = {
  jsonrpc: "2.0",
  id: 1,
  error: { code: -32014, message: "No such transaction", data: "no transaction for hash transaction-v1-hash(0000..00aa)" },
} as const;

/**
 * The CasCet mainnet deployer account (query_global_state account-hash-b9a38c82…),
 * recorded 2026-11-02: one associated key (itself), thresholds 1/1. Named keys
 * trimmed to one.
 */
export const mainnetDeployerAccountResponse = {
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "api_version": "2.0.0",
    "block_header": null,
    "stored_value": {
      "Account": {
        "account_hash": "account-hash-b9a38c827771d6bc510dd5f1e24fee61acdd4f97f758f4d68fe1dea13a7a140d",
        "named_keys": [
          {
            "name": "CasCet_X402_package_hash",
            "key": "hash-8dd4f1aafde3895bee3b8155f0ebb14b1c82c4effe895dfb06ea50f9bc35be41"
          }
        ],
        "main_purse": "uref-0522f0c3812ca5b328dbe10fc5a060b5e16029b058567403095e11aebc0012a9-007",
        "associated_keys": [
          {
            "account_hash": "account-hash-b9a38c827771d6bc510dd5f1e24fee61acdd4f97f758f4d68fe1dea13a7a140d",
            "weight": 1
          }
        ],
        "action_thresholds": {
          "deployment": 1,
          "key_management": 1
        }
      }
    }
  }
} as const;

/** An account that does not exist on mainnet: the node answers "value was not found". */
export const accountNotFoundResponse = {
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32003,
    "message": "Query failed",
    "data": "value was not found in the global state"
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

/** Token `name` named key on mainnet (query_global_state uref-e2b604e2…, recorded 2026-11-02). */
export const mainnetNameResponse = {
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

/** Token `chain_name` named key on mainnet (query_global_state uref-7c93dbbb…, recorded 2026-11-02). */
export const mainnetChainNameResponse = {
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "api_version": "2.0.0",
    "block_header": null,
    "stored_value": {
      "CLValue": {
        "cl_type": "String",
        "bytes": "0d0000006361737065723a636173706572",
        "parsed": "casper:casper"
      }
    }
  }
} as const;

/**
 * Testnet tx 9fe35eed… built by the hosted facilitator (@x402/casper's builder,
 * after the CEP-3009 rename): `transfer_with_authorization` with `value`, sent to
 * CasCet's legacy-amount token, which reverted with User error 64658 (Odra
 * MissingArg) and burned the whole 6 CSPR limit. Effects trimmed.
 */
export const testnetHostedValueTransaction = {
  "hash": "9fe35eed1042c4600b8c769386511ecbcf75b4a733f8aabf101e372389aa94ec",
  "payload": {
    "initiator_addr": {
      "PublicKey": "0202b2d69e2e66d9858ae7b19bfe802135ae93658146e48e1f8e1f762e00032a3449"
    },
    "timestamp": "2026-07-23T04:11:23.972Z",
    "ttl": "15m",
    "chain_name": "casper-test",
    "pricing_mode": {
      "PaymentLimited": {
        "payment_amount": 6000000000,
        "gas_price_tolerance": 1,
        "standard_payment": true
      }
    },
    "fields": {
      "args": {
        "Named": [
          [
            "from",
            {
              "cl_type": "Key",
              "bytes": "009201bf2e2468c8ae48c516dd0dadb4174a523bd1869b6d422795712a7b9d65cc",
              "parsed": "account-hash-9201bf2e2468c8ae48c516dd0dadb4174a523bd1869b6d422795712a7b9d65cc"
            }
          ],
          [
            "to",
            {
              "cl_type": "Key",
              "bytes": "005fbafb3d180056637745218c3a21bef20ad4aca0737b676125791db7a2ead0c6",
              "parsed": "account-hash-5fbafb3d180056637745218c3a21bef20ad4aca0737b676125791db7a2ead0c6"
            }
          ],
          [
            "value",
            {
              "cl_type": "U256",
              "bytes": "0340420f",
              "parsed": "1000000"
            }
          ],
          [
            "valid_after",
            {
              "cl_type": "U64",
              "bytes": "1292616a00000000",
              "parsed": 1784779282
            }
          ],
          [
            "valid_before",
            {
              "cl_type": "U64",
              "bytes": "9695616a00000000",
              "parsed": 1784780182
            }
          ],
          [
            "nonce",
            {
              "cl_type": {
                "List": "U8"
              },
              "bytes": "20000000e1331519afb547796178580b25afe73423148107d2c204398c5d9e0532fc8391",
              "parsed": [
                225,
                51,
                21,
                25,
                175,
                181,
                71,
                121,
                97,
                120,
                88,
                11,
                37,
                175,
                231,
                52,
                35,
                20,
                129,
                7,
                210,
                194,
                4,
                57,
                140,
                93,
                158,
                5,
                50,
                252,
                131,
                145
              ]
            }
          ],
          [
            "public_key",
            {
              "cl_type": "PublicKey",
              "bytes": "01e6bcbfb40d9be4bdcbc083afc8bf2f3451cb3bde792e27cdb1b4501f7fc4a25d",
              "parsed": "01e6bcbfb40d9be4bdcbc083afc8bf2f3451cb3bde792e27cdb1b4501f7fc4a25d"
            }
          ],
          [
            "signature",
            {
              "cl_type": {
                "List": "U8"
              },
              "bytes": "4100000001d3c339c9ab217994edab3ec846e5d5d33b4ad4a51711dfcb5ea9addd8802a785b8ac51350e2bd02bc580e97fc1b5385f31a097adc5e42a24d8922f42a9358f0d",
              "parsed": [
                1,
                211,
                195,
                57,
                201,
                171,
                33,
                121,
                148,
                237,
                171,
                62,
                200,
                70,
                229,
                213,
                211,
                59,
                74,
                212,
                165,
                23,
                17,
                223,
                203,
                94,
                169,
                173,
                221,
                136,
                2,
                167,
                133,
                184,
                172,
                81,
                53,
                14,
                43,
                208,
                43,
                197,
                128,
                233,
                127,
                193,
                181,
                56,
                95,
                49,
                160,
                151,
                173,
                197,
                228,
                42,
                36,
                216,
                146,
                47,
                66,
                169,
                53,
                143,
                13
              ]
            }
          ]
        ]
      },
      "entry_point": {
        "Custom": "transfer_with_authorization"
      },
      "scheduling": "Standard",
      "target": {
        "Stored": {
          "id": {
            "ByPackageHash": {
              "addr": "cb65a928f8e1b7ce172bddd075c10dd0de8bcfd9cf808c799fd409766a1735c3",
              "version": null
            }
          },
          "runtime": "VmCasperV1"
        }
      }
    }
  },
  "approvals": [
    {
      "signer": "0202b2d69e2e66d9858ae7b19bfe802135ae93658146e48e1f8e1f762e00032a3449",
      "signature": "0295689d1cb8306cde2846acc11cd52b5a1ee55d198ec7fabfb222f471f17e56fd204c08dcc7040a6e9ca552608763993cb3aab9089b2b26121c35615b561d6692"
    }
  ],
  "execution_info": {
    "block_hash": "3d5d42483272da43ae70f51a217624fe40d8236f120ae78c88492e04fb847ef9",
    "block_height": 8594884,
    "execution_result": {
      "Version2": {
        "initiator": {
          "PublicKey": "0202b2d69e2e66d9858ae7b19bfe802135ae93658146e48e1f8e1f762e00032a3449"
        },
        "error_message": "User error: 64658",
        "current_price": 1,
        "limit": "6000000000",
        "consumed": "9719645",
        "cost": "6000000000",
        "refund": "0",
        "size_estimate": 892
      }
    }
  }
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
