# Food records

Published nutrition values the scanner prefers over model estimates. `food-records.v1.json` is loaded at boot by `src/modules/content/food-records.service.ts`. Every value is per 100 g of the food as eaten. `null` means the source has no value.

A record is used only on an exact name match (`aliases`, case and punctuation ignored) with a matching method (`preparations`). A near miss stays an AI estimate: a wrong record is worse than an honest estimate.

| Source | Used for | Terms |
|---|---|---|
| Food Composition Table for Bangladesh, 2013 (INFS, University of Dhaka; hosted by FAO). Codes like `01_0041` | Staples, boiled foods, recipes marked `*` in the table | FAO lists it as free access with no licence stated. **Confirm with the publisher before commercial launch.** |
| USDA FoodData Central. IDs like `2707427` | Dal, curries, biryani, fried egg | Public domain (CC0 1.0) |

How the file was made (4 Nov 2026): values were read by script from `FCDB_7_4_14.xlsx` and from the FoodData Central API, not typed by hand.

- Bracketed fibre values in the Bangladesh table are crude fibre, not total dietary fibre, so they are stored as `null`.
- `Tr` (trace) is stored as 0.
- Sugar comes from the table's sugar annex, which covers few foods, so sugar is `null` for most Bangladeshi entries.
- Every record had to pass an energy check (kcal against protein, carbohydrate, fat and fibre). The validator repeats it. Several boiled vegetables in the source fail it (for example brinjal: 6.6 g fat at 26 kcal) and are left out.
- The USDA dishes are American survey recipes. Kacchi biryani has no alias on purpose: its oil content is far from that recipe, so it stays an AI estimate.

To add a record, cite a published source in `source` and `sourceRef`, then run `pnpm content:validate`. Never add values from memory or from a model.
