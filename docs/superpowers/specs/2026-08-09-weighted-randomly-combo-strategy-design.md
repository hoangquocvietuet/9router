# Weighted-Randomly Combo Strategy

## Overview

Add `"weighted-randomly"` as a combo fallback strategy alongside the existing `fallback`, `round-robin`, and `fusion`. Each model in a combo gets a weight; on every request, a single model is picked weighted-randomly. If it fails with a fallback-able error, the failed model is excluded and the pick repeats from the remaining pool.

Weights live in `comboStrategies[name].weights` (consistent with how `judgeModel` and `fusionTuning` already sit alongside `fallbackStrategy` for the same combo).

## Strategy behavior

1. Read `comboStrategies[name].weights`. Resolve each model's weight as `Number(weight)`, defaulting to 1 if missing or unparseable. Models with weight 0 are excluded from the pool. If no model has a weight > 0, fall through to `fallback` behavior (try in original order).

2. Pick one model weighted-randomly. `probability(model_i) = weight_i / sum(all weights)`.

3. Call the model via the existing `handleSingleModel` callback.

4. On success → return the response.

5. On failure where `checkFallbackError` returns `shouldFallback: true` (503, 502, 504, 429, no-credentials, rate limits per the existing logic) → exclude the failed model from the pool, log the attempt, pick again with remaining weights.

6. Pool exhausted with no success → return "All combo models failed" (reuse existing all-failed response path, same as fallback/round-robin today).

## Code changes

### `open-sse/services/combo.js`

- Export `pickWeightedRandomModel(models, weights)` — pure function, deterministic given a seed (unit-testable). Takes the array of model strings and the weights object, returns one model string.
- In `handleComboChat`: when `comboStrategy === "weighted-randomly"`, substitute the for-loop with the weighted-random pick loop described above. The rest of the function (capability auto-switch, context-window filtering, logging) runs before this branch, same as today.
- `getRotatedModels` is NOT used for this strategy — it's round-robin only.

### `src/sse/handlers/chat.js` (two repetitions)

No change needed. Both sites already pass `comboStrategy` through to `handleComboChat`, which branches internally.

### `src/sse/handlers/imageGeneration.js`

No change needed. Already passes `comboStrategy` through.

### `src/app/(dashboard)/dashboard/combos/page.js`

- Add `{ value: "weighted-randomly", label: "Weighted Random — pick by weight" }` to `STRATEGY_OPTIONS`.
- In `ComboCard`: when `current === "weighted-randomly"`, render a weight editor below the strategy dropdown:
  - One row per model: `<model name>` + `<input type="number" min="0" step="1">`
  - Save on blur via `onSetStrategy({ weights: updatedWeights })`
  - Persisted to API at the parent level (see Data layer below).

### `src/app/(dashboard)/dashboard/media-providers/combo/[id]/page.js`

- Line 87: `setRoundRobin` handles only round-robin today — extend to also read weights.
- When saving strategy from the detail page, include weights if present.

### Data layer

- `comboStrategies` object in settings already supports arbitrary keys per-combo. `weights` is just another key alongside `fallbackStrategy`, `judgeModel`, `fusionTuning`. No schema change.
- API: `PUT /api/settings` body includes `comboStrategies["name"].weights` — the settings route already merges arbitrary keys into the settings JSON. No API change needed.

### Tests

`tests/unit/combo-routing.test.js` or a new `tests/unit/combo-weighted-random.test.js`:

- `pickWeightedRandomModel` returns a model from the given array.
- Model with weight 0 is never returned.
- All weights 0 → returns `null` (caller falls back to fallback behavior).
- Distribution approximates declared weights over many iterations (statistical test with tolerance).
- Missing weight defaults to 1.
- Invalid weight string defaults to 1.
- Existing round-robin and fallback tests remain unchanged.

### UI design

No visual mockups needed — the weight editor reuses the same inline pattern as the fusion judge picker inside `ComboCard`:

```
Round Robin — rotate     [▼]
Weighted Random — pick by weight [▼]

  openai/gpt-4o                   [3]
  anthropic/claude-opus-4-8       [3]
  google/gemini-2.5-pro           [4]
```

Weights show inline below the strategy dropdown. Save fires on blur for each field.

## Constraints

- Weights are positive integers (or 0 to disable). Floats are allowed but rendered by `Number(weight)` — user sees what they typed.
- Strategy "weighted-randomly" does NOT support sticky limit (no rotation state). The sticky param is ignored.
- Weighted-randomly works alongside `autoSwitch` (capability reordering) since that runs before the pick loop.

## Out of scope

- Sticky limit for weighted-randomly (not meaningful here).
- Weight decay or dynamic weight adjustment.
- Visual chart or distribution preview in the dashboard.
