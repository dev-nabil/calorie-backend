import type { RulePack } from './types';

const MEAT = ['beef', 'pork', 'chicken', 'turkey', 'lamb', 'bacon', 'sausage', 'steak', 'mince', 'meat', 'poultry', 'duck', 'veal', 'venison', 'salami', 'ham', 'gammon', 'burger'];
const FISH = ['fish', 'salmon', 'tuna', 'cod', 'sardine', 'mackerel', 'anchov', 'haddock', 'trout', 'herring', 'sea bass'];
const SHELLFISH = ['shellfish', 'prawn', 'shrimp', 'crab', 'lobster', 'mussel', 'oyster', 'scallop', 'squid', 'clam', 'calamari', 'octopus'];
const DAIRY = ['milk', 'dairy', 'cheese', 'yoghurt', 'yogurt', 'butter', 'cream', 'whey', 'kefir', 'ghee', 'paneer', 'custard', 'casein', 'curd', 'lassi'];
const EGG = ['egg', 'omelette', 'mayonnaise', 'mayo', 'meringue', 'frittata', 'quiche'];

export const enPack: RulePack = {
  numberWithUnit:
    /\d[\d,.]*\s*(?:-\s*\d[\d,.]*\s*)?(?:%|(?:kcal|kilocalories?|calories?|cals?|grams?|g|kg|kilos?|kilograms?|lbs?|pounds?|stones?|st|weeks?|wks?|months?|years?|percent|ml|millilitres?|milliliters?|litres?|liters?|l)\b)/i,
  spelledFigure: /\b(?:ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\b[^.!?]{0,25}\b(?:kcal|calories?|grams?|kilos?|kilograms?|pounds?|weeks?|months?|percent|litres?)\b/i,
  bannedWording:
    /\b(?:good food|bad food|junk|cheat(?: meal| day)?|guilt[- ]free|naughty|sinful|clean eating|detox|cleanse|crash diet|starv\w*|laxatives?|purg\w*|punish\w*|burn(?:ing)? off|earn(?:ed|ing)? (?:your|a) (?:meal|treat)|make up for|compensat\w+)\b/i,
  restriction: /\b(?:cut out|eliminate|remove|drop|ban|never eat)\s+(?:all |every |any )?(?:carbs?|carbohydrates?|sugar|fats?|dairy|gluten|bread)\b|\bweigh yourself\s+(?:every|each|daily|morning)/i,
  fastingPlan: /\b(?:intermittent fasting|fasting window|fast for|skip (?:a |your )?(?:meals?|breakfast|lunch|dinner)|16:8|omad)\b/i,
  medicalClaim: /\b(?:diagnos\w*|prescri\w*|dosage|cure[sd]?|treats? your|reverse your)\b/i,
  safeCue: /\b(?:avoid\w*|allerg\w*|intoleran\w*|without|[a-z]+-free|free from|swap\w*|substitut\w*|instead of|alternativ\w*|steer clear|leave out|leaving out|skip)\b/i,
  allergens: {
    peanuts: ['peanut', 'groundnut', 'satay'],
    tree_nuts: ['almond', 'walnut', 'cashew', 'hazelnut', 'pecan', 'pistachio', 'macadamia', 'brazil nut', 'tree nut', 'marzipan', 'praline', 'pesto', 'nutella', 'nut'],
    milk: DAIRY,
    lactose: ['milk', 'cheese', 'yoghurt', 'yogurt', 'cream', 'kefir', 'custard', 'paneer', 'curd', 'lassi', 'whey'],
    eggs: EGG,
    gluten: ['wheat', 'gluten', 'bread', 'pasta', 'barley', 'rye', 'couscous', 'toast', 'noodle', 'cereal', 'oat', 'semolina', 'bulgur', 'flour', 'pastry', 'bagel', 'tortilla', 'cracker', 'biscuit', 'pizza', 'granola', 'muesli', 'porridge', 'sandwich', 'wrap'],
    soy: ['soy', 'soya', 'tofu', 'edamame', 'tempeh', 'miso', 'tamari'],
    fish: FISH,
    shellfish: SHELLFISH,
    sesame: ['sesame', 'tahini', 'hummus', 'halva'],
  },
  patterns: {
    veg: [...MEAT, ...FISH, ...SHELLFISH, 'gelatine'],
    vegan: [...MEAT, ...FISH, ...SHELLFISH, 'gelatine', ...DAIRY, ...EGG, 'honey'],
    pesc: MEAT,
  },
};
