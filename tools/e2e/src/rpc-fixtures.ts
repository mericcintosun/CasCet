/* eslint-disable */
/**
 * Recorded, read-only Casper JSON-RPC responses used as test fixtures.
 *
 * Recorded on 2026-11-01 from https://node.testnet.casper.network/rpc and
 * https://node.mainnet.casper.network/rpc (query_global_state, info_get_transaction).
 * Trimmed: merkle proofs, contract entry points and transaction effects are
 * removed; everything else is verbatim.
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
