# MISTAKES.md

## Enforced Rules (check every task)

## Patterns (promote at 3 hits)
- Category matching between wger and Sparky must key on NAME only, never name|unit. Units are formatted differently across the two systems ('lb' vs 'lbs', 'ms', 'N/A'), so a name|unit key misses an existing category and tries to re-create a duplicate -> 400 (seen for "Body weight" in BOTH directions). Fixed in sparky-to-wger.ts and wger-to-sparky.ts. (hits: 2)

## Observations (first sightings)
- 2026-09-05: wger measurement.value is DecimalField(max_digits=8, decimal_places=2, min 0). Sending raw floats -> HTTP 400 "no more than 8 digits"/"2 decimal places" (was ~298/run). Round to 2 dp before POST/PATCH and reject out-of-range in WgerClient.upsertMeasurement. (hits: 1)
- 2026-09-05: Some Sparky categories are non-numeric (e.g. "Raw Stress Data", measurement_type 'JSON' = a JSON time-series). safeNumber returned null and counted each as an error + logged a huge blob (347KB logs). Skip categories whose unit/measurement_type is in NON_NUMERIC_UNITS and treat an unparseable value as a skip, not an error; truncate the warning. (hits: 1)
- 2026-09-05: The axios clients (wger.ts, sparky.ts) set NO request timeout. A single hung upstream request would wedge a phase forever; since the watermark only advances when totalErrors==0, a wedge (or any residual error) makes every hourly run reprocess the full backlog and overlap ("previous run still in progress, skipping"). Consider adding an axios timeout + advancing the watermark past permanently-bad records. (hits: 1)
- 2026-09-05: Deploy is repo-backed (Komodo clones ATECHPCS/wger-sparky-bridge#main). Switched compose from `image: ghcr.io/...` (manual push, no CI) to `build:` from the git repo with GH_BUILD_TOKEN + pull_policy: build, matching grocy-cook. No more manual GHCR pushes. (hits: 1)
