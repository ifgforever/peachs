// Peach's on 47th: menu data.
// Source of truth: docs/content-inventory.md (restaurant menu updated 2/26,
// kids menu updated 3/26, catering menu 11.25). Keep names, prices and tags
// in sync with that file; do not add tags the printed menu does not carry.
//
// Item shape:
//   { name, portion?, price?, prices?: [{ label, value }], desc?, tags?: ['GF'|'V'|'DF'], star? }
// `price` is a single number; `prices` is for items sold in several sizes
// (rendered as "6 / 9 / 12" with the size labels underneath).

export const DIETARY = {
  GF: 'Gluten free',
  V: 'Vegetarian',
  DF: 'Dairy free',
};

export const MENU_UPDATED = '2/26';

export const MENU_SECTIONS = [
  {
    id: 'plates',
    title: "Peach's Plates",
    short: "Peach's Plates",
    items: [
      { name: 'Fried Catfish, Greens & Grits', price: 23, desc: 'Cornmeal & flour fried catfish with grits & collard greens' },
      { name: 'Bayou Breakfast Bowl', price: 24, desc: 'Shrimp, alligator sausage, potatoes, green peppers, onion, mushrooms, tomatoes, scallions, & cheddar cheese with your choice of egg on top and a side of chicken gravy' },
      { name: 'Breakfast Bowl', price: 17, desc: 'Potatoes, green peppers, onions, mushrooms, tomatoes, cheddar cheese & a scallion garnish with your choice of egg', tags: ['GF', 'V'] },
      { name: 'Hangover Plate', price: 20, desc: 'Fried chicken thighs tossed in our signature sweet & spicy hangover sauce, served with (2) eggs any style & a cup of grits. Upgrade to all wings for $1' },
      { name: 'Biscuit & Gravy', price: 12, desc: 'Homemade biscuit smothered with chicken sausage, green peppers & chicken gravy' },
      { name: "Peach's Special", price: 20, desc: '(2) eggs any style with a choice of meat (pork/turkey bacon or pork sausage links), house potatoes or grits & pancakes or toast. Upgrade meat options available' },
      { name: 'Yardbird & Sweet Toast', price: 18, desc: 'Fried chicken thighs with cinnamon french toast & sweet honey butter' },
      { name: '“The Big Bird”', price: 19, desc: "Chicken sausage patties, duck bacon, gouda cheese, one egg any style on a Peach's homemade biscuit with a side of peach bourbon compote. Served with a choice of grits or house potatoes" },
      { name: 'Southern Benedict', price: 18, desc: 'Chicken gravy, chicken sausage patties, (2) poached eggs served on top of our freshly made biscuits' },
      { name: '“This Cluck’n Biscuit”', price: 10, desc: "Chicken sausage patties served on a Peach's homemade biscuit with a side of peach bourbon compote. Add 1 egg for $3.50" },
      { name: 'Avocado Toast', price: 11, desc: 'Avocado, cherry tomatoes, micro greens, feta, & balsamic glaze on toast. Add 1 egg for $3.50', tags: ['V'] },
      { name: 'DLT Sandwich', price: 15, desc: 'Duck bacon, spinach, & tomatoes with creole sauce on sourdough toast. Add 1 egg for $3.50 and choice of cheese for $2' },
      { name: 'Hangover Chicken Wings & Fries', price: 17, desc: '(4) Fried chicken wings tossed in our signature sweet & spicy hangover sauce with french fries' },
      { name: 'Duck Bowl', price: 19, desc: 'One egg any style with potatoes, green peppers, onion, spinach, cheddar cheese, & duck bacon', tags: ['GF'] },
    ],
  },
  {
    id: 'obama',
    title: "President Obama's Favorites",
    short: "Obama's Favorites",
    star: true,
    items: [
      { name: "Peach's Shrimp & Grits", price: 24, desc: 'Shrimp with garlic cream sauce, pork bacon, mushrooms, tomatoes, scallions on top of cheese or plain grits. Served with garlic Texas toast' },
      { name: 'Salmon Croquettes & Grits', price: 23, desc: 'Wild caught, fresh baked salmon croquettes served on top of cheese or plain grits', tags: ['DF', 'GF'] },
    ],
  },
  {
    id: 'pancakes',
    title: 'Pancakes & French Toast',
    short: 'Pancakes & French Toast',
    note: 'Ask your server about our seasonal specials.',
    items: [
      { name: '7-Up Pancakes', portion: 'Short stack', price: 12, desc: 'Served with lemon cream cheese frosting' },
      { name: 'Peach Bourbon French Toast', portion: '6 wedges', price: 14 },
      { name: 'Banana Rum French Toast', portion: '6 wedges', price: 14 },
      { name: 'Pancakes', prices: [{ label: 'Side', value: 6 }, { label: 'Short', value: 9 }, { label: 'Full', value: 12 }] },
      { name: 'Gluten-Free Pancakes', prices: [{ label: 'Short', value: 12 }, { label: 'Full', value: 15 }] },
      { name: 'French Toast', prices: [{ label: 'Side', value: 6 }, { label: 'Full', value: 12 }] },
      { name: 'Toppings', price: 3, desc: 'Banana rum, blueberry lemon, & peach compote' },
      { name: 'Add Brown Sugar Crumbles', price: 2, tags: ['GF'] },
    ],
  },
  {
    id: 'omelettes',
    title: 'Omelettes',
    short: 'Omelettes',
    note: 'Served with a choice of fruit cup, grits, or house potatoes.',
    items: [
      { name: 'The Soul Queen Salmon Omelette', price: 20, desc: 'Salmon, green peppers, gouda cheese, & capers on the side', tags: ['GF'] },
      { name: 'Healthy Start Omelette', price: 19, desc: '(2) egg whites with spinach, tomatoes, mushrooms, onions, green peppers, feta cheese', tags: ['GF', 'V'] },
      { name: 'DIY Omelette', price: 18, desc: 'Choose (1) protein, (1) cheese, & (1) veggie. Add chicken sausage (+3); salmon or shrimp (+5). Additional veggies (+1)', tags: ['GF'] },
    ],
  },
  {
    id: 'meat',
    title: 'Meat & Seafood',
    short: 'Meat & Seafood',
    items: [
      { name: 'Applewood Smoked Pork Bacon', portion: '(3)', price: 5 },
      { name: 'Turkey Bacon', portion: '(3)', price: 4 },
      { name: 'Pork Sausage Links', portion: '(3)', price: 4 },
      { name: 'Chicken Sausage Patties', portion: '(2)', price: 5 },
      { name: 'Side Salmon Croquette', portion: '(1)', price: 8 },
      { name: 'Side Catfish Fillet', portion: '(1)', price: 8 },
      { name: 'Shrimp & Sauce', portion: '(3)', price: 7 },
      { name: 'Fried Chicken Wings', portion: '(4)', price: 8 },
      { name: 'Fried Chicken Thighs', portion: '(2)', price: 9 },
      { name: 'Duck Bacon', portion: '(3)', price: 7 },
    ],
  },
  {
    id: 'sides',
    title: "Peach's on the Side",
    short: 'On the Side',
    items: [
      { name: 'One Egg, Any Style', price: 3.5 },
      { name: 'Plain Grits', price: 3, tags: ['GF', 'V'] },
      { name: 'Cheese Grits', price: 4, tags: ['GF', 'V'] },
      { name: 'Chicken Gravy', price: 4 },
      { name: 'Greens', price: 4, tags: ['GF'] },
      { name: 'Fresh Fruit Cup', price: 8 },
      { name: 'House Potatoes', price: 3, tags: ['GF', 'V'] },
      { name: 'Biscuit', price: 4 },
      { name: 'Oatmeal & Peach Bourbon Compote', price: 4 },
      { name: 'Fries', price: 7, tags: ['GF'] },
      { name: 'Toast', price: 5, desc: 'Sourdough, wheat, white, raisin, Texas toast' },
      { name: 'Fruit Topping', price: 2, desc: 'Strawberries, blueberries or bananas', tags: ['GF'] },
    ],
  },
  {
    id: 'sweets',
    title: "The Sweet Spot @ Peach's",
    short: 'Sweet Spot',
    note: 'Subject to availability.',
    items: [
      { name: 'Peach Cobbler', price: 9, star: true },
      { name: 'Happy Biscuit', price: 5, desc: 'House-made biscuit served with peach compote' },
    ],
  },
  {
    id: 'beverages',
    title: 'Beverages',
    short: 'Beverages',
    items: [
      { name: 'Freshly Brewed Coffee', price: 3.5, desc: 'Peach or Buffalo Soldier, unflavored' },
      { name: 'Hot Tea', price: 3 },
      { name: 'Peach Palmer', price: 6 },
      { name: 'Strawberry Lemonade', price: 6 },
      { name: 'Hot Chocolate', price: 5 },
      { name: 'Whole Milk', price: 2 },
      { name: 'Apple Juice', price: 4 },
      { name: 'Orange Juice', price: 3.5 },
      { name: 'Pellegrino', price: 4 },
      { name: 'Ice Mountain Water', price: 3 },
      { name: 'Soda', price: 3 },
      // Its own block on the printed menu ("subject to availability"); listed here so guests find it.
      { name: "Peach's Coffee at Home", portion: '1/2 lb', price: 14, desc: 'Whole bean or ground. Roasts: Peach, Coconut, Jamaican Rum, Buffalo Soldier. Subject to availability' },
    ],
  },
  {
    id: 'kids',
    title: 'Kids Menu',
    short: 'Kids',
    note: 'For kids 12 and under.',
    items: [
      { name: 'Chicken Littles', price: 10.5, desc: '(3-4) crispy chicken tenders with golden fries' },
      { name: 'Strawberry Shortcakes', price: 10, desc: '(2) fluffy pancakes topped with freshly sliced strawberries, fluffy whipped cream, and sprinkles of powdered sugar, with your choice of bacon or sausage links (2)' },
      { name: 'French Toast Special', price: 8.5, desc: '(2) pieces of french toast, (2) strips of bacon, and one egg' },
      { name: 'Mickey Mouse Pancake', price: 8.5, desc: 'A smiling, fluffy Mickey Mouse pancake with your choice of bacon or sausage links (2)' },
    ],
  },
];

export const FINE_PRINT = {
  party: 'Checks for parties of 6 or more cannot be split, and a 20% gratuity will be included. Peach’s on 47th reserves the right to limit modifications on menu items. Please notify your server of any and all dietary restrictions.',
  foodSafety: 'Consuming raw or undercooked foods, meats, poultry, seafood, shellfish or eggs may increase your risk of foodborne illness.',
};

export const DOWNLOADS = [
  { label: 'Full menu', detail: 'PDF · updated 2/26', href: 'menus/peachs-menu.pdf' },
  { label: 'Kids menu', detail: 'Image · updated 3/26', href: 'menus/peachs-kids-menu.webp' },
  { label: 'Catering menu', detail: 'Image · 11.25', href: 'menus/peachs-catering-menu.webp' },
];

/** Format a price the way the printed menu does: 12 → "12", 3.5 → "3.50". */
export function formatPrice(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
