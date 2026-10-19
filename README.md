# needs-custody

Verifiable receipts for the most basic human needs. BSVKey does not make water, food or
shelter. It proves the water was safe and arrived, the money reached the right person, and
the food reached the household on the list. Today those are the points where aid fails.

```
node demo.mjs     # one day at a fictional camp, all five needs, with tampering caught
node --test       # 13 tests
```

Zero dependencies, Node 18 or later. Live page with an in-browser verifier:
**https://needs.bsvkey.com**

## Anchored run: check it yourself

`runs/2026-10-19/` holds a full demo day (618 signed records). Its batch root
`162d44e9...33e8` is anchored on Bitcoin BSV mainnet in tx
[`edf5240c297f79ead29476feb1ab092470cb09f31a5b08dd28535b604762bfa7`](https://whatsonchain.com/tx/edf5240c297f79ead29476feb1ab092470cb09f31a5b08dd28535b604762bfa7).

```
node bin/verify.mjs --run runs/2026-10-19 --anchor edf5240c297f79ead29476feb1ab092470cb09f31a5b08dd28535b604762bfa7
```

Make and anchor your own day: `node demo.mjs --out runs/<day>`, then
`WALLET_JSON=<wallet.json> node bin/anchor.mjs --run runs/<day>` (needs
`npm i --no-save @bsv/sdk`). It signs but never broadcasts; sending is a separate step.

## What each module proves

| Need | Module | What a verifier learns, with only the pinned public keys |
|---|---|---|
| Water, delivered | `src/water.mjs` | The liters the site actually received, and whether the water met the Sphere standards (free chlorine at least 0.2 mg/L, turbidity under 5 NTU, no E. coli) based on a signed sensor reading taken near delivery time. Only safe, received liters count toward 15 L per person per day. |
| Water, bought | `src/meter.mjs` | A prepaid kiosk channel metered per mL. Only the buyer can raise what's owed, the kiosk accepts only the next state and never a lower volume, and the newest state settles. On close, whole satoshis go to the kiosk and the rest returns to the buyer. |
| Food | `src/aid.mjs` | Loss on each leg, attributed to whoever held the food (the receiver signs the weight). Households appear only as salted tags under a Merkle root, and each handout carries a proof of entitlement. Double claims, unlisted tags and inflated rations are rejected. |
| Shelter (disaster money) | `src/parametric.mjs` | A drought policy pays only when a quorum of distinct, pinned rainfall sources read below the trigger. Anyone can re-run the decision. A source that signs two values for one window is excluded, and a payout to another payee or for another amount fails. |
| Communication | `src/offline.mjs` | Field devices keep a hash-linked log while offline. When the link returns, shuffled and resent entries reassemble, and deleted, edited or forked entries are caught. |
| All of the above | `src/anchor.mjs` | Each day's records go into one Merkle root in a 50-byte `OP_FALSE OP_RETURN` script on Bitcoin BSV, with a short inclusion proof per record. |

## Limits

- The demo signs with Ed25519. Production uses the same content addressing with the
  Bitcoin Signed Message envelope, swapped in behind `lib/keys.mjs`, as in the other
  custody repos.
- `anchor.mjs` builds the script and `bin/anchor.mjs` signs it; neither broadcasts. Sending is
  a separate, deliberate step.
- A signature proves who said something, not that it is true. A bribed water committee
  can sign for water it never got. The design limits each party to their own signature,
  so a lie traces back to one named signer, and a sensor reading is still required for
  "safe".
- The offline log can't detect a truncated tail on its own. The daily anchor, or the
  next entry that arrives, closes that gap.
- Equivocation exclusion means a source that double-signs can block a payout. That's a
  deliberate trade-off: one compromised source can delay a payout but never cause a
  false one.

## License

Apache-2.0. Copyright 2026 Embryo Space Inc. (DBA BSVKey).
