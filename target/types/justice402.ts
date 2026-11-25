/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/justice402.json`.
 */
export type Justice402 = {
  "address": "D8uK7oT6f1pcZzK2Dq1NhL7wdNp51sS5ZhuNy4wf8WYD",
  "metadata": {
    "name": "justice402",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Justice402 accountability layer for x402"
  },
  "instructions": [
    {
      "name": "claimTimeout",
      "discriminator": [
        130,
        234,
        45,
        53,
        120,
        90,
        86,
        178
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Permissionless caller: anyone (buyer, keeper, provider) can trigger timeout refund after deadline"
          ],
          "signer": true
        },
        {
          "name": "config"
        },
        {
          "name": "dispute",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  105,
                  115,
                  112,
                  117,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "dispute.receipt_hash",
                "account": "dispute"
              }
            ]
          }
        },
        {
          "name": "provider",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  118,
                  105,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "provider.wallet",
                "account": "provider"
              }
            ]
          }
        },
        {
          "name": "buyerRecord",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  121,
                  101,
                  114,
                  95,
                  114,
                  101,
                  99,
                  111,
                  114,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "provider.wallet",
                "account": "provider"
              },
              {
                "kind": "account",
                "path": "dispute.buyer",
                "account": "dispute"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "config"
              }
            ]
          }
        },
        {
          "name": "buyerTokenAccount",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "initialize",
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "config"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "arbiter",
          "type": "pubkey"
        },
        {
          "name": "disputeWindow",
          "type": "i64"
        },
        {
          "name": "resolveTimeout",
          "type": "i64"
        },
        {
          "name": "withdrawDelay",
          "type": "i64"
        },
        {
          "name": "perRulingPayoutCap",
          "type": "u64"
        },
        {
          "name": "disputeDeposit",
          "type": "u64"
        },
        {
          "name": "maxOpenDisputesPerBuyer",
          "type": "u32"
        }
      ]
    },
    {
      "name": "openDispute",
      "discriminator": [
        137,
        25,
        99,
        119,
        23,
        223,
        161,
        42
      ],
      "accounts": [
        {
          "name": "buyer",
          "writable": true,
          "signer": true
        },
        {
          "name": "provider",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  118,
                  105,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "provider.wallet",
                "account": "provider"
              }
            ]
          }
        },
        {
          "name": "buyerRecord",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  121,
                  101,
                  114,
                  95,
                  114,
                  101,
                  99,
                  111,
                  114,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "provider.wallet",
                "account": "provider"
              },
              {
                "kind": "account",
                "path": "buyer"
              }
            ]
          }
        },
        {
          "name": "dispute",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  105,
                  115,
                  112,
                  117,
                  116,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "receipt"
              }
            ]
          }
        },
        {
          "name": "config"
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "config"
              }
            ]
          }
        },
        {
          "name": "buyerTokenAccount",
          "writable": true
        },
        {
          "name": "instructionsSysvar",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "receipt",
          "type": {
            "defined": {
              "name": "receipt"
            }
          }
        },
        {
          "name": "evidenceHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "registerProvider",
      "discriminator": [
        254,
        209,
        54,
        184,
        46,
        197,
        109,
        78
      ],
      "accounts": [
        {
          "name": "providerWallet",
          "writable": true,
          "signer": true
        },
        {
          "name": "provider",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  118,
                  105,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "providerWallet"
              }
            ]
          }
        },
        {
          "name": "config"
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "config"
              }
            ]
          }
        },
        {
          "name": "providerTokenAccount",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "bondAmount",
          "type": "u64"
        },
        {
          "name": "specHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "requestWithdraw",
      "discriminator": [
        137,
        95,
        187,
        96,
        250,
        138,
        31,
        182
      ],
      "accounts": [
        {
          "name": "providerWallet",
          "signer": true
        },
        {
          "name": "provider",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  118,
                  105,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "providerWallet"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "resolveDispute",
      "discriminator": [
        231,
        6,
        202,
        6,
        96,
        103,
        12,
        230
      ],
      "accounts": [
        {
          "name": "arbiter",
          "signer": true
        },
        {
          "name": "config"
        },
        {
          "name": "dispute",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  105,
                  115,
                  112,
                  117,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "dispute.receipt_hash",
                "account": "dispute"
              }
            ]
          }
        },
        {
          "name": "provider",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  118,
                  105,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "provider.wallet",
                "account": "provider"
              }
            ]
          }
        },
        {
          "name": "buyerRecord",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  121,
                  101,
                  114,
                  95,
                  114,
                  101,
                  99,
                  111,
                  114,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "provider.wallet",
                "account": "provider"
              },
              {
                "kind": "account",
                "path": "dispute.buyer",
                "account": "dispute"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "config"
              }
            ]
          }
        },
        {
          "name": "buyerTokenAccount",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "ruling",
          "type": {
            "defined": {
              "name": "ruling"
            }
          }
        },
        {
          "name": "rulingHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "topUp",
      "discriminator": [
        236,
        225,
        96,
        9,
        60,
        106,
        77,
        208
      ],
      "accounts": [
        {
          "name": "providerWallet",
          "writable": true,
          "signer": true
        },
        {
          "name": "provider",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  118,
                  105,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "providerWallet"
              }
            ]
          }
        },
        {
          "name": "config"
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "config"
              }
            ]
          }
        },
        {
          "name": "providerTokenAccount",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "withdrawBond",
      "discriminator": [
        222,
        199,
        141,
        31,
        188,
        93,
        155,
        40
      ],
      "accounts": [
        {
          "name": "providerWallet",
          "signer": true
        },
        {
          "name": "provider",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  118,
                  105,
                  100,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "providerWallet"
              }
            ]
          }
        },
        {
          "name": "config"
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "config"
              }
            ]
          }
        },
        {
          "name": "providerTokenAccount",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "buyerRecord",
      "discriminator": [
        107,
        122,
        54,
        31,
        4,
        54,
        209,
        38
      ]
    },
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "dispute",
      "discriminator": [
        36,
        49,
        241,
        67,
        40,
        36,
        241,
        74
      ]
    },
    {
      "name": "provider",
      "discriminator": [
        164,
        180,
        71,
        17,
        75,
        216,
        80,
        195
      ]
    }
  ],
  "events": [
    {
      "name": "bondToppedUp",
      "discriminator": [
        182,
        139,
        47,
        228,
        13,
        187,
        220,
        146
      ]
    },
    {
      "name": "bondWithdrawn",
      "discriminator": [
        111,
        192,
        154,
        231,
        58,
        115,
        130,
        103
      ]
    },
    {
      "name": "disputeOpened",
      "discriminator": [
        239,
        222,
        102,
        235,
        193,
        85,
        1,
        214
      ]
    },
    {
      "name": "disputeResolved",
      "discriminator": [
        121,
        64,
        249,
        153,
        139,
        128,
        236,
        187
      ]
    },
    {
      "name": "providerRegistered",
      "discriminator": [
        38,
        209,
        137,
        78,
        185,
        19,
        147,
        14
      ]
    },
    {
      "name": "withdrawRequested",
      "discriminator": [
        114,
        16,
        240,
        206,
        93,
        128,
        151,
        39
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "mathOverflow",
      "msg": "Calculation overflowed"
    },
    {
      "code": 6001,
      "name": "invalidConfig",
      "msg": "Invalid configuration parameter"
    },
    {
      "code": 6002,
      "name": "windowExpired",
      "msg": "Dispute window has expired"
    },
    {
      "code": 6003,
      "name": "unauthorizedBuyer",
      "msg": "Only the buyer named in the receipt can open a dispute"
    },
    {
      "code": 6004,
      "name": "wrongSigner",
      "msg": "Receipt signer does not match provider wallet"
    },
    {
      "code": 6005,
      "name": "wrongMessage",
      "msg": "Ed25519 signature verified message does not match canonical receipt"
    },
    {
      "code": 6006,
      "name": "missingEd25519Instruction",
      "msg": "Missing required Ed25519 signature verification instruction in transaction"
    },
    {
      "code": 6007,
      "name": "invalidEd25519Data",
      "msg": "Invalid Ed25519 instruction data layout or length"
    },
    {
      "code": 6008,
      "name": "invalidEd25519Offset",
      "msg": "Ed25519 instruction offset points outside instruction data"
    },
    {
      "code": 6009,
      "name": "invalidReceipt",
      "msg": "Receipt length or version invalid"
    },
    {
      "code": 6010,
      "name": "insufficientBond",
      "msg": "Insufficient bond available to open dispute"
    },
    {
      "code": 6011,
      "name": "unauthorizedArbiter",
      "msg": "Caller is not the configured arbiter"
    },
    {
      "code": 6012,
      "name": "disputeAlreadyResolved",
      "msg": "Dispute is already resolved"
    },
    {
      "code": 6013,
      "name": "disputeNotOpen",
      "msg": "Dispute is not in Open status"
    },
    {
      "code": 6014,
      "name": "timeoutNotReached",
      "msg": "Resolve timeout has not yet elapsed"
    },
    {
      "code": 6015,
      "name": "resolveTimeoutElapsed",
      "msg": "Resolve timeout has elapsed; dispute can only be settled via claim_timeout"
    },
    {
      "code": 6016,
      "name": "bondLocked",
      "msg": "Cannot withdraw while funds are locked in active disputes"
    },
    {
      "code": 6017,
      "name": "activeDisputesPending",
      "msg": "Cannot withdraw while disputes are open"
    },
    {
      "code": 6018,
      "name": "specHashMismatch",
      "msg": "Receipt spec hash does not match provider registered spec hash"
    },
    {
      "code": 6019,
      "name": "withdrawDelayNotElapsed",
      "msg": "Withdraw delay has not elapsed since request"
    },
    {
      "code": 6020,
      "name": "withdrawNotRequested",
      "msg": "Withdrawal has not been requested"
    },
    {
      "code": 6021,
      "name": "insufficientWithdrawBalance",
      "msg": "Requested amount exceeds available unreserved bond"
    },
    {
      "code": 6022,
      "name": "tooManyOpenDisputes",
      "msg": "Maximum open disputes per buyer exceeded for this provider"
    }
  ],
  "types": [
    {
      "name": "bondToppedUp",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "provider",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "totalBond",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "bondWithdrawn",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "provider",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "remainingBond",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "buyerRecord",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "openDisputes",
            "type": "u32"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "arbiter",
            "type": "pubkey"
          },
          {
            "name": "usdcMint",
            "type": "pubkey"
          },
          {
            "name": "disputeWindow",
            "type": "i64"
          },
          {
            "name": "resolveTimeout",
            "type": "i64"
          },
          {
            "name": "withdrawDelay",
            "type": "i64"
          },
          {
            "name": "perRulingPayoutCap",
            "type": "u64"
          },
          {
            "name": "disputeDeposit",
            "type": "u64"
          },
          {
            "name": "maxOpenDisputesPerBuyer",
            "type": "u32"
          },
          {
            "name": "vaultBump",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "dispute",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "receiptHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "provider",
            "type": "pubkey"
          },
          {
            "name": "specHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "claimAmount",
            "type": "u64"
          },
          {
            "name": "depositAmount",
            "type": "u64"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "disputeStatus"
              }
            }
          },
          {
            "name": "openedAt",
            "type": "i64"
          },
          {
            "name": "evidenceHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "rulingHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "disputeOpened",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "receiptHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "provider",
            "type": "pubkey"
          },
          {
            "name": "specHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "claimAmount",
            "type": "u64"
          },
          {
            "name": "depositAmount",
            "type": "u64"
          },
          {
            "name": "openedAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "disputeResolved",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "receiptHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "provider",
            "type": "pubkey"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "disputeStatus"
              }
            }
          },
          {
            "name": "rulingHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "payout",
            "type": "u64"
          },
          {
            "name": "resolvedAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "disputeStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "open"
          },
          {
            "name": "buyerWins"
          },
          {
            "name": "providerWins"
          },
          {
            "name": "timedOut"
          }
        ]
      }
    },
    {
      "name": "provider",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "wallet",
            "type": "pubkey"
          },
          {
            "name": "bond",
            "type": "u64"
          },
          {
            "name": "locked",
            "type": "u64"
          },
          {
            "name": "withdrawRequestedAt",
            "type": "i64"
          },
          {
            "name": "specHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "openDisputes",
            "type": "u64"
          },
          {
            "name": "disputesBuyerWon",
            "type": "u64"
          },
          {
            "name": "disputesProviderWon",
            "type": "u64"
          },
          {
            "name": "disputesTimedOut",
            "type": "u64"
          },
          {
            "name": "totalSlashed",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "providerRegistered",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "provider",
            "type": "pubkey"
          },
          {
            "name": "bond",
            "type": "u64"
          },
          {
            "name": "specHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "registeredAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "receipt",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "provider",
            "type": "pubkey"
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "specHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "requestHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "responseHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "paymentReference",
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          },
          {
            "name": "price",
            "type": "u64"
          },
          {
            "name": "timestamp",
            "type": "i64"
          },
          {
            "name": "nonce",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "ruling",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "buyerWins"
          },
          {
            "name": "providerWins"
          }
        ]
      }
    },
    {
      "name": "withdrawRequested",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "provider",
            "type": "pubkey"
          },
          {
            "name": "requestedAt",
            "type": "i64"
          }
        ]
      }
    }
  ]
};
