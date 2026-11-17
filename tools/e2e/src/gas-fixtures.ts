/* eslint-disable */
/**
 * Recorded, read-only `info_get_transaction` answers used as gas-report fixtures.
 *
 * Recorded from https://node.testnet.casper.network/rpc and
 * https://node.mainnet.casper.network/rpc (2026-11-01 and 2026-11-02). Trimmed:
 * effects, transfers, approvals, session module bytes and the parsed form of
 * List<U8> arguments are removed; everything else is verbatim.
 */

/** Testnet WCSPR wrap 77fb850a… (2026-10-27): deposit() of 1 CSPR through a 52,814-byte proxy session; the account already had a cargo purse. Limit 5, consumed 0.9876, refund 3.0093 CSPR. */
export const wcsprDepositResult = {
  "api_version": "2.0.0",
  "transaction": {
    "Version1": {
      "hash": "77fb850aabeaa171b60f7703b70316abd66cf346fee68f7683ff48ef32183b84",
      "payload": {
        "initiator_addr": {
          "PublicKey": "0202b1943511b8c23b1b2b8ed7ddcedffcc7be70d9366a5005c7beab08a81b7ae633"
        },
        "timestamp": "2026-10-27T11:34:58.428Z",
        "ttl": "30m",
        "chain_name": "casper-test",
        "pricing_mode": {
          "PaymentLimited": {
            "payment_amount": 5000000000,
            "gas_price_tolerance": 1,
            "standard_payment": true
          }
        },
        "fields": {
          "args": {
            "Named": [
              [
                "package_hash",
                {
                  "cl_type": {
                    "ByteArray": 32
                  },
                  "bytes": "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e",
                  "parsed": "3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e"
                }
              ],
              [
                "entry_point",
                {
                  "cl_type": "String",
                  "bytes": "070000006465706f736974",
                  "parsed": "deposit"
                }
              ],
              [
                "args",
                {
                  "cl_type": {
                    "List": "U8"
                  },
                  "bytes": "0400000000000000"
                }
              ],
              [
                "attached_value",
                {
                  "cl_type": "U512",
                  "bytes": "0400ca9a3b",
                  "parsed": "1000000000"
                }
              ],
              [
                "amount",
                {
                  "cl_type": "U512",
                  "bytes": "0400ca9a3b",
                  "parsed": "1000000000"
                }
              ]
            ]
          },
          "entry_point": "Call",
          "scheduling": "Standard",
          "target": {
            "Session": {
              "is_install_upgrade": true,
              "runtime": "VmCasperV1"
            }
          }
        }
      }
    }
  },
  "execution_info": {
    "block_hash": "a5a8b8f30bab88cde4460db335078d2ceece50cb1066cb8e32fd2cdafc535a82",
    "block_height": 9634546,
    "execution_result": {
      "Version2": {
        "initiator": {
          "PublicKey": "0202b1943511b8c23b1b2b8ed7ddcedffcc7be70d9366a5005c7beab08a81b7ae633"
        },
        "error_message": null,
        "current_price": 1,
        "limit": "5000000000",
        "consumed": "987646582",
        "cost": "5000000000",
        "refund": "3009265063",
        "size_estimate": 53422
      }
    }
  }
} as const;

/** Testnet settle 2ffeb8c7… by the hosted facilitator before the CEP-3009 rename: `amount` on CasCet's legacy token, success. Limit 6, consumed 2.7078, refund 2.4691 CSPR. */
export const hostedLegacySettleResult = {
  "api_version": "2.0.0",
  "transaction": {
    "Version1": {
      "hash": "2ffeb8c7a9313cb1df7affc1fc50669bf0ea19be9474498e6960273ea470a8b3",
      "payload": {
        "initiator_addr": {
          "PublicKey": "0202b2d69e2e66d9858ae7b19bfe802135ae93658146e48e1f8e1f762e00032a3449"
        },
        "timestamp": "2026-07-07T20:53:26.568Z",
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
                  "bytes": "ed644d6a00000000",
                  "parsed": 1783457005
                }
              ],
              [
                "valid_before",
                {
                  "cl_type": "U64",
                  "bytes": "71684d6a00000000",
                  "parsed": 1783457905
                }
              ],
              [
                "nonce",
                {
                  "cl_type": {
                    "List": "U8"
                  },
                  "bytes": "2000000026b7777679891e1310952b8f12b55d6d50754c482e2fdbac5bc3ca9136f641eb"
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
                  "bytes": "41000000010494019158edcbd00681cf75133ec1866bca91a74b4e7544d9d6cbf12883f48dd401215db19c69d0713137915d5bc8262b9aac2e5acb3385439c0bd7294d8b06"
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
      }
    }
  },
  "execution_info": {
    "block_hash": "331ffacf4898fcade0ad4432f417d161c1df86fe7518311c7d47a56d73d15182",
    "block_height": 8429643,
    "execution_result": {
      "Version2": {
        "initiator": {
          "PublicKey": "0202b2d69e2e66d9858ae7b19bfe802135ae93658146e48e1f8e1f762e00032a3449"
        },
        "error_message": null,
        "current_price": 1,
        "limit": "6000000000",
        "consumed": "2707825069",
        "cost": "6000000000",
        "refund": "2469131198",
        "size_estimate": 894
      }
    }
  }
} as const;

/** Testnet settle 9fe35eed… by the hosted facilitator after the rename: `value` on CasCet's legacy token, reverted with User error 64658 (MissingArg). Limit 6 burned, refund 0. */
export const hostedValueOnLegacyTokenResult = {
  "api_version": "2.0.0",
  "transaction": {
    "Version1": {
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
                  "bytes": "20000000e1331519afb547796178580b25afe73423148107d2c204398c5d9e0532fc8391"
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
                  "bytes": "4100000001d3c339c9ab217994edab3ec846e5d5d33b4ad4a51711dfcb5ea9addd8802a785b8ac51350e2bd02bc580e97fc1b5385f31a097adc5e42a24d8922f42a9358f0d"
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
      }
    }
  },
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

/** Mainnet settle 754224da… of CasCet's legacy token by the self-hosted facilitator. Limit 7, consumed 2.6962, refund 3.2279 CSPR. */
export const mainnetLegacySettleResult = {
  "api_version": "2.0.0",
  "transaction": {
    "Version1": {
      "hash": "754224da36db9ecaef8399e720fc04fc2bc4605b383c63964788860db25533b7",
      "payload": {
        "initiator_addr": {
          "PublicKey": "01c3a787f115de28a0fff3a37d02d345f12f7c74a85408559052c4d36379242826"
        },
        "timestamp": "2026-07-22T21:12:57.433Z",
        "ttl": "30m",
        "chain_name": "casper",
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
                  "bytes": "00b9a38c827771d6bc510dd5f1e24fee61acdd4f97f758f4d68fe1dea13a7a140d",
                  "parsed": "account-hash-b9a38c827771d6bc510dd5f1e24fee61acdd4f97f758f4d68fe1dea13a7a140d"
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
                  "bytes": "0130616a00000000",
                  "parsed": 1784754177
                }
              ],
              [
                "valid_before",
                {
                  "cl_type": "U64",
                  "bytes": "8533616a00000000",
                  "parsed": 1784755077
                }
              ],
              [
                "nonce",
                {
                  "cl_type": {
                    "List": "U8"
                  },
                  "bytes": "20000000199eca4591d701e9f006908a6a5de3e9040296beed475080247dbc835eb57f70"
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
                  "bytes": "4100000001497534a36577da2d6e02e6251f5ff4038725c6be32f4a574caa10fef2492f23df8521d616ba35c707403ca72cd2930aa2b34898de095e1d39dd496be7df8ab07"
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
                  "addr": "8dd4f1aafde3895bee3b8155f0ebb14b1c82c4effe895dfb06ea50f9bc35be41",
                  "version": null
                }
              },
              "runtime": "VmCasperV1"
            }
          }
        }
      }
    }
  },
  "execution_info": {
    "block_hash": "a4ea08b737666a7731cd8fc9c6ee0d1aa33afde954fcf582006e272c665e2f8c",
    "block_height": 8352399,
    "execution_result": {
      "Version2": {
        "initiator": {
          "PublicKey": "01c3a787f115de28a0fff3a37d02d345f12f7c74a85408559052c4d36379242826"
        },
        "error_message": null,
        "current_price": 1,
        "limit": "7000000000",
        "consumed": "2696193533",
        "cost": "7000000000",
        "refund": "3227854850",
        "size_estimate": 887
      }
    }
  }
} as const;

/** Testnet ReceiptRegistry anchor 70e4c416… (`record`, recorded 2026-11-02). Limit 5, consumed 1.1511, refund 2.8867 CSPR. */
export const anchorRecordResult = {
  "api_version": "2.0.0",
  "transaction": {
    "Version1": {
      "hash": "70e4c41654b884a72079876bb01c33feaafc50a2b8f558bcc226b8876b8c5f92",
      "payload": {
        "initiator_addr": {
          "PublicKey": "01dd710d5083920b20c706a92d742c7bf9162d09c96fa373bd0a67b0bf51d3f183"
        },
        "timestamp": "2026-07-22T22:22:16.369Z",
        "ttl": "30m",
        "chain_name": "casper-test",
        "pricing_mode": {
          "PaymentLimited": {
            "payment_amount": 5000000000,
            "gas_price_tolerance": 1,
            "standard_payment": true
          }
        },
        "fields": {
          "args": {
            "Named": [
              [
                "payment_id",
                {
                  "cl_type": "String",
                  "bytes": "2400000062663964646532642d636265362d346237362d383831312d656365636637666266613831",
                  "parsed": "bf9dde2d-cbe6-4b76-8811-ececf7fbfa81"
                }
              ],
              [
                "parent_id",
                {
                  "cl_type": "String",
                  "bytes": "00000000",
                  "parsed": ""
                }
              ],
              [
                "payer",
                {
                  "cl_type": "String",
                  "bytes": "42000000303036353139303132366231636132383266303431666164366237346238343561336334386530633834313133393262313363363430613136613134333866616639",
                  "parsed": "0065190126b1ca282f041fad6b74b845a3c48e0c8411392b13c640a16a1438faf9"
                }
              ],
              [
                "payee",
                {
                  "cl_type": "String",
                  "bytes": "42000000303035316134663863613163313836623065393366663636323865326332333033646564356233636433343366636132323065383239636535343034313161626633",
                  "parsed": "0051a4f8ca1c186b0e93ff6628e2c2303ded5b3cd343fca220e829ce540411abf3"
                }
              ],
              [
                "amount",
                {
                  "cl_type": "U256",
                  "bytes": "0500f2052a01",
                  "parsed": "5000000000"
                }
              ],
              [
                "server",
                {
                  "cl_type": "String",
                  "bytes": "11000000706f7274666f6c696f2d616e616c797374",
                  "parsed": "portfolio-analyst"
                }
              ],
              [
                "tool",
                {
                  "cl_type": "String",
                  "bytes": "11000000616e616c797a655f706f7274666f6c696f",
                  "parsed": "analyze_portfolio"
                }
              ],
              [
                "tx_hash",
                {
                  "cl_type": "String",
                  "bytes": "4000000061393663356266623331353162653338303530333165653134646430313138616261613231393335323333396139643030383766616230336230666166653237",
                  "parsed": "a96c5bfb3151be3805031ee14dd0118abaa219352339a9d0087fab03b0fafe27"
                }
              ]
            ]
          },
          "entry_point": {
            "Custom": "record"
          },
          "scheduling": "Standard",
          "target": {
            "Stored": {
              "id": {
                "ByPackageHash": {
                  "addr": "bdf8422b69d7bfb7581e7b2c63fbfb0fc8b23701181289411170bce5cf996f97",
                  "version": null
                }
              },
              "runtime": "VmCasperV1"
            }
          }
        }
      }
    }
  },
  "execution_info": {
    "block_hash": "79355e9d529703f2c06838f8d947e7992ccfb9a8a6c00b1c497a249d8487a903",
    "block_height": 8592266,
    "execution_result": {
      "Version2": {
        "initiator": {
          "PublicKey": "01dd710d5083920b20c706a92d742c7bf9162d09c96fa373bd0a67b0bf51d3f183"
        },
        "error_message": null,
        "current_price": 1,
        "limit": "5000000000",
        "consumed": "1151081880",
        "cost": "5000000000",
        "refund": "2886688590",
        "size_estimate": 937
      }
    }
  }
} as const;

/** Testnet CEP-18 `transfer` d299b19b… of 300 CasCet X402 Token by the earlier fund-token (recorded 2026-11-02). Limit 5, consumed 0.4545, refund 3.4091 CSPR. */
export const cep18TransferResult = {
  "api_version": "2.0.0",
  "transaction": {
    "Version1": {
      "hash": "d299b19b69b6f003cd43d55469520b5f154b17571f9cc20067f6bffd5eb629c2",
      "payload": {
        "initiator_addr": {
          "PublicKey": "01dd710d5083920b20c706a92d742c7bf9162d09c96fa373bd0a67b0bf51d3f183"
        },
        "timestamp": "2026-07-22T04:55:28.418Z",
        "ttl": "30m",
        "chain_name": "casper-test",
        "pricing_mode": {
          "PaymentLimited": {
            "payment_amount": 5000000000,
            "gas_price_tolerance": 1,
            "standard_payment": true
          }
        },
        "fields": {
          "args": {
            "Named": [
              [
                "recipient",
                {
                  "cl_type": "Key",
                  "bytes": "0014bfcdac542657e71a39a77b72500700021100e280facf627c7d0049cb23ab47",
                  "parsed": "account-hash-14bfcdac542657e71a39a77b72500700021100e280facf627c7d0049cb23ab47"
                }
              ],
              [
                "amount",
                {
                  "cl_type": "U256",
                  "bytes": "0500b864d945",
                  "parsed": "300000000000"
                }
              ]
            ]
          },
          "entry_point": {
            "Custom": "transfer"
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
      }
    }
  },
  "execution_info": {
    "block_hash": "815b64b0ef04af25f0a6ee350e51f8e413ecc6ee1fbe29da2b4df2f270d2f466",
    "block_height": 8584418,
    "execution_result": {
      "Version2": {
        "initiator": {
          "PublicKey": "01dd710d5083920b20c706a92d742c7bf9162d09c96fa373bd0a67b0bf51d3f183"
        },
        "error_message": null,
        "current_price": 1,
        "limit": "5000000000",
        "consumed": "454491144",
        "cost": "5000000000",
        "refund": "3409131642",
        "size_estimate": 587
      }
    }
  }
} as const;
