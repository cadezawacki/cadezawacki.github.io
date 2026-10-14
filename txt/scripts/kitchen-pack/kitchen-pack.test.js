/* Unit tests for the Kitchen Pack pure model (recipe scaling, fraction
 * formatting, aisle classification + merging, unit conversion).
 * Not loaded by the app (not in the manifest). Run: node txt/scripts/kitchen-pack/kitchen-pack.test.js */
'use strict';
var assert = require('assert');
var K = require('./kitchen-pack.js');

var passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL ' + name + '\n' + (e.stack || e)); process.exitCode = 1; }
}
function scale(t, f) { return K.scaleText(t, f).text; }
// each [input, factor, expected]
function table(rows) { rows.forEach(function (r) { assert.strictEqual(scale(r[0], r[1]), r[2], JSON.stringify(r[0]) + ' ×' + r[1]); }); }

// =========================================================================== numbers
test('parseNum: integers, decimals, fractions, unicode, mixed, thousands', function () {
  var v = function (s) { var p = K.parseNum(s); return p && [Math.round(p.v * 1000) / 1000, p.style]; };
  assert.deepStrictEqual(v('2'), [2, 'int']);
  assert.deepStrictEqual(v('1.5'), [1.5, 'dec']);
  assert.deepStrictEqual(v('.5'), [0.5, 'dec']);
  assert.deepStrictEqual(v('1,5'), [1.5, 'dec']);
  assert.deepStrictEqual(v('1,000'), [1000, 'int']);
  assert.deepStrictEqual(v('3/4'), [0.75, 'frac']);
  assert.deepStrictEqual(v('1 1/2'), [1.5, 'frac']);
  assert.deepStrictEqual(v('1-1/2'), [1.5, 'frac']);
  assert.deepStrictEqual(v('1⁄2'), [0.5, 'frac']);
  assert.deepStrictEqual(v('¾'), [0.75, 'uni']);
  assert.deepStrictEqual(v('1½'), [1.5, 'uni']);
  assert.deepStrictEqual(v('2 ⅓'), [2.333, 'uni']);
  assert.strictEqual(K.parseNum('10/14'), null);   // a date
  assert.strictEqual(K.parseNum('1 5/4'), null);
  assert.strictEqual(K.parseNum('abc'), null);
});

test('nearestFrac + fmtFrac: eighths and thirds, never zero', function () {
  var f = function (v, d, u) { return K.fmtFrac(K.nearestFrac(v, d || [2, 3, 4, 8]), u); };
  assert.strictEqual(f(0.5), '1/2');
  assert.strictEqual(f(0.333), '1/3');
  assert.strictEqual(f(0.6667), '2/3');
  assert.strictEqual(f(0.625), '5/8');
  assert.strictEqual(f(1.875), '1 7/8');
  assert.strictEqual(f(2.98), '3');
  assert.strictEqual(f(0.01), '1/8');               // a positive amount never becomes 0
  assert.strictEqual(f(1.5, null, true), '1½');
  assert.strictEqual(f(0.75, null, true), '¾');
  assert.strictEqual(f(2.3, [2, 4]), '2 1/4');
  assert.strictEqual(K.fmtDec(2.25, 2), '2.25');
  assert.strictEqual(K.fmtDec(2.5, 2, true), '2,5');
  assert.strictEqual(K.fmtFactor(1.5), '1.5');
  assert.strictEqual(K.fmtFactor(1 / 3), '1/3');
  assert.strictEqual(K.fmtFactor(2), '2');
});

// =========================================================================== factor input
test('parseFactor: factors, multipliers, fractions, percentages, words', function () {
  var f = function (s, sv) { var r = K.parseFactor(s, sv); return r.error ? 'ERR' : Math.round(r.factor * 10000) / 10000; };
  assert.strictEqual(f('2'), 2);
  assert.strictEqual(f('0.5'), 0.5);
  assert.strictEqual(f('.5'), 0.5);
  assert.strictEqual(f('x1.5'), 1.5);
  assert.strictEqual(f('×2'), 2);
  assert.strictEqual(f('1.5x'), 1.5);
  assert.strictEqual(f('* 3'), 3);
  assert.strictEqual(f('1/2'), 0.5);
  assert.strictEqual(f('1 1/2'), 1.5);
  assert.strictEqual(f('½'), 0.5);
  assert.strictEqual(f('150%'), 1.5);
  assert.strictEqual(f('/2'), 0.5);
  assert.strictEqual(f('double'), 2);
  assert.strictEqual(f('Half'), 0.5);
  assert.strictEqual(f('triple'), 3);
});

test('parseFactor: servings from → to, and target servings', function () {
  var f = function (s, sv) { var r = K.parseFactor(s, sv); return r.error ? 'ERR' : Math.round(r.factor * 10000) / 10000; };
  assert.strictEqual(f('4 to 6'), 1.5);
  assert.strictEqual(f('4->6'), 1.5);
  assert.strictEqual(f('4 → 6'), 1.5);
  assert.strictEqual(f('4-6'), 1.5);
  assert.strictEqual(f('from 4 to 6 servings'), 1.5);
  assert.strictEqual(f('serves 8 to 2'), 0.25);
  assert.strictEqual(f('6 servings', 4), 1.5);
  assert.strictEqual(f('for 2', 4), 0.5);
  assert.strictEqual(f('serves 10', 4), 2.5);
  assert.strictEqual(f('6 servings', null), 'ERR');      // no "Serves N" to start from
  assert.ok(/Serves N/.test(K.parseFactor('6 servings', null).error));
  ['', 'abc', '0', '-2', '0 to 4', '5000'].forEach(function (s) { assert.strictEqual(f(s), 'ERR', s); });
});

test('findServings', function () {
  assert.strictEqual(K.findServings('# Chili\nServes 6\n'), 6);
  assert.strictEqual(K.findServings('Servings: 4-6'), 4);
  assert.strictEqual(K.findServings('Yield: 24 cookies'), 24);
  assert.strictEqual(K.findServings('Makes about 12 muffins'), 12);
  assert.strictEqual(K.findServings('Enough for 4 people'), 4);
  assert.strictEqual(K.findServings('2 cups flour'), null);
});

// =========================================================================== scaling: a full US recipe
var PANCAKES = [
  '# Fluffy Pancakes',
  'Serves 4 · Prep 10 minutes · Cook 15 min',
  '',
  '## Ingredients',
  '- 1 1/2 cups all-purpose flour (190g)',
  '- 3 1/2 tsp baking powder',
  '- 1/4 tsp salt',
  '- 1 tbsp sugar',
  '- 1¼ cups milk',
  '- 1 large egg',
  '- 3 tbsp butter, melted',
  '- 2-3 tbsp maple syrup',
  '',
  '## Steps',
  '1. Preheat the oven to 200°F to keep pancakes warm.',
  '2. Whisk the flour, baking powder, salt and sugar.',
  '3. Pour 1/4 cup of batter for each pancake; cook 2 to 3 minutes per side.',
  '4. Makes about 12 pancakes.',
].join('\n');

test('scale a US pancake recipe ×2', function () {
  assert.strictEqual(scale(PANCAKES, 2), [
    '# Fluffy Pancakes',
    'Serves 8 · Prep 10 minutes · Cook 15 min',
    '',
    '## Ingredients',
    '- 3 cups all-purpose flour (380g)',
    '- 7 tsp baking powder',
    '- 1/2 tsp salt',
    '- 2 tbsp sugar',
    '- 2½ cups milk',
    '- 2 large eggs',
    '- 6 tbsp butter, melted',
    '- 4-6 tbsp maple syrup',
    '',
    '## Steps',
    '1. Preheat the oven to 200°F to keep pancakes warm.',
    '2. Whisk the flour, baking powder, salt and sugar.',
    '3. Pour 1/4 cup of batter for each pancake; cook 2 to 3 minutes per side.',
    '4. Makes about 24 pancakes.',
  ].join('\n'));
});

test('scale the same recipe ×0.5 and ×1.5 (fractions, egg note, unit switches)', function () {
  var half = scale(PANCAKES, 0.5).split('\n');
  assert.deepStrictEqual(half.slice(1, 2).concat(half.slice(4, 12)), [
    'Serves 2 · Prep 10 minutes · Cook 15 min',
    '- 3/4 cup all-purpose flour (95g)',
    '- 1 3/4 tsp baking powder',
    '- 1/8 tsp salt',
    '- 1/2 tbsp sugar',
    '- ⅝ cup milk',
    '- 1 large egg (~0.5)',
    '- 1 1/2 tbsp butter, melted',
    '- 1-1 1/2 tbsp maple syrup',
  ]);
  var x15 = scale(PANCAKES, 1.5).split('\n');
  assert.deepStrictEqual(x15.slice(4, 12), [
    '- 2 1/4 cups all-purpose flour (285g)',
    '- 5 1/4 tsp baking powder',
    '- 3/8 tsp salt',
    '- 1 1/2 tbsp sugar',
    '- 1⅞ cups milk',
    '- 2 large eggs (~1.5)',
    '- 4 1/2 tbsp butter, melted',
    '- 3-4 1/2 tbsp maple syrup',
  ]);
});

test('re-scaling uses the noted exact egg amount', function () {
  var once = scale('- 3 eggs', 0.5);
  assert.strictEqual(once, '- 2 eggs (~1.5)');
  assert.strictEqual(scale(once, 2), '- 3 eggs');
  assert.strictEqual(scale('- 2 large eggs (~1.5)', 0.5), '- 1 large egg (~0.75)');
  assert.strictEqual(scale('2 egg yolks and 1 egg white', 0.5), '1 egg yolk and 1 egg white (~0.5)');
  assert.strictEqual(scale('- 1 egg, beaten', 3), '- 3 eggs, beaten');
});

// =========================================================================== scaling: metric / UK recipes
test('scale a UK Victoria sponge (grams, ml, °C, gas mark, tin size) ×1.5', function () {
  var cake = [
    'Victoria sponge — serves 8',
    '- 200g caster sugar',
    '- 200g softened butter',
    '- 4 eggs, beaten',
    '- 200g self-raising flour',
    '- 1 tsp baking powder',
    '- 2 tbsp milk',
    '- 300 ml double cream',
    '- 1,5 kg strawberries',
    'Heat oven to 190C/170C fan/gas 5. Butter two 20cm sandwich tins.',
    'Bake for 20 mins until golden. Gas mark 4 also works.',
  ].join('\n');
  assert.strictEqual(scale(cake, 1.5), [
    'Victoria sponge — serves 12',
    '- 300g caster sugar',
    '- 300g softened butter',
    '- 6 eggs, beaten',
    '- 300g self-raising flour',
    '- 1 1/2 tsp baking powder',
    '- 3 tbsp milk',
    '- 450 ml double cream',
    '- 2,25 kg strawberries',
    'Heat oven to 190C/170C fan/gas 5. Butter two 20cm sandwich tins.',
    'Bake for 20 mins until golden. Gas mark 4 also works.',
  ].join('\n'));
});

test('metric rounding and g ↔ kg, ml ↔ l', function () {
  table([
    ['7g dried yeast', 0.5, '3.5g dried yeast'],
    ['7 g salt', 1 / 3, '2.5 g salt'],
    ['125 g butter', 1.5, '190 g butter'],
    ['25 g pine nuts', 1.5, '38 g pine nuts'],
    ['600 g flour', 2, '1.2 kg flour'],
    ['750 ml stock', 2, '1.5 l stock'],
    ['1 L water', 0.25, '250 ml water'],
    ['1.5 kg chicken thighs', 0.5, '750 g chicken thighs'],
    ['2 kg potatoes', 1.25, '2.5 kg potatoes'],
    ['0.5 g saffron', 3, '1.5 g saffron'],
    ['400 mL coconut milk', 2, '800 mL coconut milk'],
    ['200g/7oz plain flour', 2, '400g/14oz plain flour'],
  ]);
});

// =========================================================================== US units
test('US volume: eighths / thirds and friendlier units', function () {
  table([
    ['1/3 cup oil', 2, '2/3 cup oil'],
    ['1/3 cup oil', 1.5, '1/2 cup oil'],
    ['1/8 cup oil', 0.5, '1 tbsp oil'],
    ['1/4 cup honey', 0.5, '2 tbsp honey'],
    ['1/2 tsp vanilla', 6, '1 tbsp vanilla'],
    ['1 1/2 teaspoons vanilla extract', 2, '1 tablespoon vanilla extract'],
    ['4 tablespoons butter', 2, '1/2 cup butter'],
    ['2 tbsp oil', 2, '1/4 cup oil'],
    ['1 tbsp soy sauce', 0.25, '3/4 tsp soy sauce'],
    ['1/4 tsp cayenne', 0.25, '1/8 tsp cayenne'],
    ['1 cup milk', 3, '3 cups milk'],
    ['2 cups (480 ml) whole milk', 0.5, '1 cup (240 ml) whole milk'],
    ['1 1/2 - 2 cups broth', 2, '3 - 4 cups broth'],
    ['1/2-1 cup water', 0.5, '1/4-1/2 cup water'],
    ['2 C. sugar', 1.5, '3 C. sugar'],
    ['1 T olive oil, 1 t salt', 2, '2 T olive oil, 2 t salt'],
    ['1 Tbsp lemon juice', 0.5, '1/2 Tbsp lemon juice'],
    ['1.5 cups rice', 1.5, '2 1/4 cups rice'],      // cups always come out as fractions
    ['1 pint cherry tomatoes', 2, '2 pints cherry tomatoes'],
    ['2 fl oz lime juice', 1.5, '3 fl oz lime juice'],
  ]);
});

test('US weight: oz ↔ lb, decimals kept when written so', function () {
  table([
    ['8 oz cream cheese', 2, '1 lb cream cheese'],
    ['12 oz pasta', 2, '1 1/2 lb pasta'],
    ['6 oz spinach', 1.5, '9 oz spinach'],
    ['1 lb ground beef', 0.5, '1/2 lb ground beef'],
    ['1 lb ground beef', 0.125, '2 oz ground beef'],
    ['- [ ] 2 lbs chicken breasts', 0.5, '- [ ] 1 lb chicken breasts'],
    ['0.75 lb shrimp', 2, '1.5 lb shrimp'],
    ['1 lb 2 oz beef', 2, '2 lb 4 oz beef'],
    ['3 pounds potatoes', 0.5, '1 1/2 pounds potatoes'],
    ['1 pound pork', 2, '2 pounds pork'],
    ['2 pounds pork', 0.5, '1 pound pork'],
  ]);
});

// =========================================================================== counts, nouns, containers
test('counts: fractions, plural / singular nouns, containers, x-notation', function () {
  table([
    ['1 onion, diced', 2, '2 onions, diced'],
    ['2 onions, diced', 0.5, '1 onion, diced'],
    ['1 small red onion, finely chopped', 2, '2 small red onions, finely chopped'],
    ['3 medium carrots, peeled', 0.5, '1 1/2 medium carrots, peeled'],
    ['1 lemon, zested and juiced', 0.5, '1/2 lemon, zested and juiced'],
    ['2 to 3 limes, juiced', 0.5, '1 to 1 1/2 limes, juiced'],
    ['1 bay leaf', 3, '3 bay leaves'],
    ['2 cloves garlic', 0.5, '1 clove garlic'],
    ['4 garlic cloves', 0.25, '1 garlic clove'],
    ['1 cherry', 2, '2 cherries'],
    ['2 tomatoes', 0.5, '1 tomato'],
    ['2 Granny Smith apples', 2, '4 Granny Smith apples'],
    ['2 Granny Smith', 0.5, '1 Granny Smith'],               // not a plural we wrote: left alone
    ['1 (14 oz) can coconut milk', 2, '2 (14 oz) cans coconut milk'],
    ['2 (15-ounce) cans black beans', 0.5, '1 (15-ounce) can black beans'],
    ['2 x 400g tins chopped tomatoes', 0.5, '1 x 400g tin chopped tomatoes'],
    ['x2 eggs', 2, 'x4 eggs'],
    ['3x bananas', 2, '6x bananas'],
    ['1 stick (113g) butter, softened', 2, '2 sticks (225g) butter, softened'],
    ['12 cookies', 1.5, '18 cookies'],
    ['14 slices bacon', 0.5, '7 slices bacon'],
    ['1 bunch cilantro', 2, '2 bunches cilantro'],
    ['3 sprigs thyme', 1 / 3, '1 sprig thyme'],
  ]);
});

test('word amounts: a / an / one / two / half a', function () {
  table([
    ['Add a pinch of salt and a cup of flour', 2, 'Add 2 pinches of salt and 2 cups of flour'],
    ['Add a pinch of salt and a cup of flour', 0.5, 'Add a pinch of salt and 1/2 cup of flour'],
    ['two cups rice, half a cup cream', 2, '4 cups rice, 1 cup cream'],
    ['One 14-oz can beans', 2, '2 14-oz cans beans'],
    ['One 14-oz can beans', 0.5, '1/2 14-oz can beans'],
    ['a can of chickpeas', 2, '2 cans of chickpeas'],
    ['Bake for an hour in a 9-inch pan with a large egg', 2, 'Bake for an hour in a 9-inch pan with a large egg'],
  ]);
});

test('servings and yields stay whole numbers', function () {
  table([
    ['Serves 4', 1.5, 'Serves 6'],
    ['Serves 4', 1 / 3, 'Serves 1'],
    ['Serves: 4-6 people', 1.5, 'Serves: 6-9 people'],
    ['Makes 12-14 cookies', 2, 'Makes 24-28 cookies'],
    ['Yield: 2 loaves', 1.5, 'Yield: 3 loaves'],
    ['Feeds 10', 0.25, 'Feeds 3'],
  ]);
});

test('pack sizes: "400g can" counts cans, "15-ounce can" keeps its size', function () {
  table([
    ['- 400g can chopped tomatoes', 1.5, '- 1 1/2 x 400g cans chopped tomatoes'],
    ['- 400g can chopped tomatoes', 2, '- 2 x 400g cans chopped tomatoes'],
    ['- 14 oz can coconut milk', 0.5, '- 1/2 x 14 oz can coconut milk'],
    ['- 2 15-ounce cans black beans', 2, '- 4 15-ounce cans black beans'],
    ['- 500g bag of spinach', 2, '- 2 x 500g bags of spinach'],
    ['- 200g feta', 2, '- 400g feta'],
  ]);
});

test('nutrition: per-serving lines stay, a servings line that mentions kcal still scales', function () {
  table([
    ['Serves 4 (about 520 kcal per serving)', 1.5, 'Serves 6 (about 520 kcal per serving)'],
    ['Nutrition: 350 calories, 12 g fat, 4 g protein', 2, 'Nutrition: 350 calories, 12 g fat, 4 g protein'],
    ['Per serving: 9g protein', 2, 'Per serving: 9g protein'],
    ['Calories: 250 | Fat: 9g | Carbs: 30g', 2, 'Calories: 250 | Fat: 9g | Carbs: 30g'],
    ['- 1 cup low-fat milk and 1 tbsp sugar', 2, '- 2 cups low-fat milk and 2 tbsp sugar'],
    ['- 10 g sugar', 2, '- 20 g sugar'],
  ]);
});

// =========================================================================== what must NOT change
test('left alone: steps, temperatures, times, years, sizes, %, money, clocks, ids', function () {
  var keep = [
    '1. Preheat oven to 350°F (180 °C).',
    '2) Heat oven to 425 degrees F.',
    '## 3. Make the dough',
    'Step 2: fold. Steps 4-5 repeat. Day 3 rest.',
    'Preheat the oven to 375.',
    'Bake at 200C for 20 mins, then 10-15 minutes more.',
    'Cook 2 to 3 minutes per side; rest 1 hour; chill overnight or 2-3 days.',
    'Prep time: 15 | Cook time: 30',
    'Granny’s 1954 recipe, updated in 2026; popular in the 1990s.',
    'Use a 9x13 dish or a 9 x 13 inch pan; an 8-inch round; cut into 1-inch cubes, 2 cm thick.',
    'Use 2% milk and 70% dark chocolate.',
    'Costs $5 at the store; item #12.',
    'Dinner at 7pm or 7:30 pm; ratio 1:2 rice to water; 10/14 delivery.',
    'Call 555-1234 or visit https://example.com/recipe/12 and [link](https://x.y/2-cups).',
    '3-ingredient cookies, B12 drops, 7up, 4K oven.',
    'Pour 1/4 cup of batter for each pancake.',
    'Add 2 tbsp at a time; 1 egg per person.',
    'Nutrition (per serving): 350 calories, 12 g fat, 4 g protein.',
    'Stir 3 times and cook in 2 batches.',
    'Set the mixer to speed 2, the microwave to power 7, gas mark 4.',
    '`2 cups` is code here',
    'Version 1.2.3 of the 3rd edition',
  ].join('\n');
  assert.strictEqual(scale(keep, 2), keep);
  assert.strictEqual(K.scaleText(keep, 2).changed, 0);
});

test('code fences are skipped, inline code too, the rest still scales', function () {
  var t = 'Use 2 cups flour.\n```\nfor (i = 0; i < 2; i++) x(1/2);\n```\n`3 cups` stays; 3 cups doubles\n~~~\n4 eggs\n~~~';
  assert.strictEqual(scale(t, 2), 'Use 4 cups flour.\n```\nfor (i = 0; i < 2; i++) x(1/2);\n```\n`3 cups` stays; 6 cups doubles\n~~~\n4 eggs\n~~~');
});

test('scaleText reports how many quantities changed and how many eggs got a note', function () {
  var r = K.scaleText('- 3 eggs\n- 2 cups milk\n- Preheat to 350F', 0.5);
  assert.deepStrictEqual([r.changed, r.eggs], [2, 1]);
});

// =========================================================================== a few more real recipes
test('chili with cans, ranges, spices, toppings ×2', function () {
  var chili = [
    'Easy beef chili (serves 6)',
    '- 2 tbsp olive oil',
    '- 1 large onion, chopped',
    '- 3 cloves garlic, minced',
    '- 2 lb ground beef',
    '- 2 (15 oz) cans kidney beans, drained',
    '- 1 (28-ounce) can crushed tomatoes',
    '- 2-3 tsp chili powder',
    '- 1 1/2 tsp ground cumin',
    '- 1/2 tsp cayenne pepper',
    '- 1 cup beef broth',
    '- Salt and pepper to taste',
    'Simmer 45 minutes to 1 hour. Top with 1/2 cup shredded cheddar per bowl.',
  ].join('\n');
  assert.strictEqual(scale(chili, 2), [
    'Easy beef chili (serves 12)',
    '- 1/4 cup olive oil',
    '- 2 large onions, chopped',
    '- 6 cloves garlic, minced',
    '- 4 lb ground beef',
    '- 4 (15 oz) cans kidney beans, drained',
    '- 2 (28-ounce) cans crushed tomatoes',
    '- 4-6 tsp chili powder',
    '- 1 tbsp ground cumin',
    '- 1 tsp cayenne pepper',
    '- 2 cups beef broth',
    '- Salt and pepper to taste',
    'Simmer 45 minutes to 1 hour. Top with 1/2 cup shredded cheddar per bowl.',
  ].join('\n'));
});

test('chocolate chip cookies ×0.5 (yield, sticks, unicode, temperatures)', function () {
  var cookies = [
    '## Chocolate chip cookies',
    'Makes 24 cookies',
    '* 2¼ cups flour',
    '* 1 tsp baking soda',
    '* 1 cup (2 sticks) butter',
    '* ¾ cup sugar',
    '* ¾ cup packed brown sugar',
    '* 2 large eggs',
    '* 2 cups chocolate chips',
    'Bake at 375°F for 9 to 11 minutes on an ungreased sheet.',
  ].join('\n');
  assert.strictEqual(scale(cookies, 0.5), [
    '## Chocolate chip cookies',
    'Makes 12 cookies',
    '* 1⅛ cups flour',
    '* 1/2 tsp baking soda',
    '* 1/2 cup (1 stick) butter',
    '* ⅜ cup sugar',
    '* ⅜ cup packed brown sugar',
    '* 1 large egg',
    '* 1 cup chocolate chips',
    'Bake at 375°F for 9 to 11 minutes on an ungreased sheet.',
  ].join('\n'));
});

test('bread with a numbered method and checkboxes ×1.5', function () {
  var bread = [
    '- [ ] 500 g strong white flour',
    '- [x] 7 g instant yeast',
    '- [ ] 10 g salt',
    '- [ ] 320 ml warm water',
    '1. Mix everything for 10 minutes.',
    '2. Prove for 1-2 hours, then shape into 2 loaves.',
    '3. Bake at 220 °C for 30-35 minutes.',
  ].join('\n');
  assert.strictEqual(scale(bread, 1.5), [
    '- [ ] 750 g strong white flour',
    '- [x] 10.5 g instant yeast',
    '- [ ] 15 g salt',
    '- [ ] 480 ml warm water',
    '1. Mix everything for 10 minutes.',
    '2. Prove for 1-2 hours, then shape into 3 loaves.',
    '3. Bake at 220 °C for 30-35 minutes.',
  ].join('\n'));
});

// =========================================================================== shopping: classification
test('dictionary is big (600+ terms) and covers every aisle but Other', function () {
  assert.ok(K.DICT_SIZE >= 600, 'only ' + K.DICT_SIZE);
  var per = {};
  Object.keys(K.DICT).forEach(function (k) { per[K.DICT[k]] = (per[K.DICT[k]] || 0) + 1; });
  K.AISLES.slice(0, -1).forEach(function (a) { assert.ok(per[a] >= 40, a + ': ' + per[a]); });
});

test('classify: real items, plurals, US/UK synonyms, compounds, modifiers', function () {
  var cases = {
    'Produce': ['strawberries', 'Bananas', 'baby spinach', 'red peppers', 'jalapeños', 'courgettes', 'aubergine', 'rocket', 'spring onions', 'garlic', 'garlic cloves', 'fresh thyme', 'green beans', 'sweet potatoes', 'cherry tomatoes', 'butter lettuce', 'avocados', 'tofu', 'lemons'],
    'Bakery': ['bread', 'sourdough loaf', 'bagels', 'hot dog buns', 'corn tortillas', 'English muffins', 'croissants', 'pizza dough', 'naan'],
    'Dairy & Eggs': ['milk', '2% milk', 'oat milk', 'eggs', 'cheddar cheese', 'cream cheese', 'sour cream', 'greek yogurt', 'unsalted butter', 'heavy cream', 'coffee creamer', 'half and half'],
    'Meat & Seafood': ['chicken breasts', 'ground beef', 'mince', 'pork chops', 'salmon fillets', 'shrimp', 'bacon', 'hot dogs', 'tuna steak', 'lamb chops', 'sausages'],
    'Deli': ['sliced turkey', 'salami', 'ham', 'hummus', 'rotisserie chicken', 'potato salad', 'deli turkey'],
    'Pantry': ['peanut butter', 'coconut milk', 'canned tomatoes', '2 x 400g tins tomatoes', 'chicken broth', 'spaghetti', 'basmati rice', 'black beans', 'olive oil', 'soy sauce', 'tuna', 'lemon juice', 'mayo', 'ketchup', 'oats', 'breadcrumbs', 'jar of pickles'],
    'Spices & Baking': ['flour', 'brown sugar', 'baking soda', 'garlic powder', 'black pepper', 'thyme', 'cinnamon', 'vanilla extract', 'chocolate chips', 'yeast', 'cornstarch', 'icing sugar'],
    'Frozen': ['frozen peas', 'ice cream', 'Ben & Jerry’s ice cream', 'frozen pizza', 'ice', 'fish fingers', 'ice cream sandwiches', 'tater tots', 'frozen strawberries'],
    'Snacks': ['tortilla chips', 'crisps', 'chocolate chip cookies', 'peanut butter cups', 'granola bars', 'pretzels', 'popcorn', 'dried cranberries', 'pine nuts', 'beef jerky'],
    'Beverages': ['orange juice', 'sparkling water', 'coffee beans', 'tea bags', 'wine', 'beer', 'coconut water', 'kombucha', 'diet coke'],
    'Household': ['paper towels', 'kitchen roll', 'toilet paper', 'bin bags', 'freezer bags', 'washing up liquid', 'dish soap', 'AA batteries', 'coffee filters', 'aluminum foil', 'tin foil', 'light bulbs'],
    'Personal Care': ['toothpaste', 'shampoo', 'bar soap', 'deodorant', 'ibuprofen', 'band-aids', 'sunscreen', 'vitamins', 'razors'],
    'Baby & Pets': ['diapers', 'nappies', 'baby wipes', 'baby food', 'dog food', 'cat litter', 'dog treats', 'fish food', 'formula'],
    'Other': ['mystery thing', 'birthday present for Sam', '42'],
  };
  Object.keys(cases).forEach(function (aisle) {
    cases[aisle].forEach(function (item) { assert.strictEqual(K.classify(item), aisle, item); });
  });
});

test('stripQty: prefix, suffix, units, containers, words', function () {
  var q = function (s) { var r = K.stripQty(s); return [r.qty, r.unit ? r.unit.key : null, r.name]; };
  assert.deepStrictEqual(q('2 apples'), [2, null, 'apples']);
  assert.deepStrictEqual(q('500g mince'), [500, 'g', 'mince']);
  assert.deepStrictEqual(q('1 bag of rice'), [1, 'bag', 'rice']);
  assert.deepStrictEqual(q('2 L milk'), [2, 'l', 'milk']);
  assert.deepStrictEqual(q('milk x2'), [2, null, 'milk']);
  assert.deepStrictEqual(q('milk (3)'), [3, null, 'milk']);
  assert.deepStrictEqual(q('2x milk'), [2, null, 'milk']);
  assert.deepStrictEqual(q('x2 milk'), [2, null, 'milk']);
  assert.deepStrictEqual(q('chicken 2 lb'), [2, 'lb', 'chicken']);
  assert.deepStrictEqual(q('a dozen eggs'), [1, 'dozen', 'eggs']);
  assert.deepStrictEqual(q('milk'), [null, null, 'milk']);
  assert.deepStrictEqual(q('7up'), [null, null, '7up']);
});

// =========================================================================== shopping: sorting
var LIST = [
  '# Groceries',
  '- [ ] milk',
  '- [ ] 2 apples',
  '- [x] bread',
  '- [ ] chicken breasts',
  '- [ ] paper towels',
  '- [ ] Milk',
  '- [ ] 3 apples',
  '- [ ] frozen peas',
  '- [x] bananas',
  '- [ ] 500g mince',
  '- [ ] 250 g mince',
  '- [x] eggs',
  '- [ ] eggs x2',
  '- [ ] eggs',
  '- [ ] 1 kg flour',
  '- [ ] 500 g flour',
  '- [ ] toothpaste',
  '- [ ] hummus',
  '    - the spicy one',
  '- [ ] mystery thing',
].join('\n');

test('sort a checklist: aisles in order, checked last, duplicates merged', function () {
  var r = K.sortShoppingList(LIST);
  assert.strictEqual(r.text, [
    '# Groceries',
    '',
    '## Produce',
    '- [ ] 5 apples',
    '- [x] bananas',
    '',
    '## Bakery',
    '- [x] bread',
    '',
    '## Dairy & Eggs',
    '- [ ] milk',
    '- [ ] eggs x2',
    '- [x] eggs',
    '',
    '## Meat & Seafood',
    '- [ ] chicken breasts',
    '- [ ] 750g mince',
    '',
    '## Deli',
    '- [ ] hummus',
    '    - the spicy one',
    '',
    '## Spices & Baking',
    '- [ ] 1.5 kg flour',
    '',
    '## Frozen',
    '- [ ] frozen peas',
    '',
    '## Household',
    '- [ ] paper towels',
    '',
    '## Personal Care',
    '- [ ] toothpaste',
    '',
    '## Other',
    '- [ ] mystery thing',
  ].join('\n'));
  assert.deepStrictEqual([r.items, r.groups, r.merged], [19, 10, 5]); // the nested note isn't an item
});

test('sorting is idempotent (run it again after adding items)', function () {
  var once = K.sortShoppingList(LIST).text;
  assert.strictEqual(K.sortShoppingList(once).text, once);
  var more = once + '\n- [ ] 2 bananas\n- [ ] dish soap';
  var twice = K.sortShoppingList(more).text;
  assert.ok(/## Produce\n- \[ \] 5 apples\n- \[ \] 2 bananas\n- \[x\] bananas/.test(twice), twice);
  assert.ok(/## Household\n- \[ \] paper towels\n- \[ \] dish soap/.test(twice), twice);
});

test('plain lines, numbered lists (renumbered), prose kept as a note', function () {
  var r = K.sortShoppingList(['milk', 'eggs', 'bananas', 'Buy everything at the market on Saturday morning.', 'tortilla chips', 'tortillas', '1. shampoo', '2. diapers', '3. cat litter'].join('\n'));
  assert.strictEqual(r.text, [
    'Buy everything at the market on Saturday morning.',
    '',
    '## Produce', 'bananas',
    '',
    '## Bakery', 'tortillas',
    '',
    '## Dairy & Eggs', 'milk', 'eggs',
    '',
    '## Snacks', 'tortilla chips',
    '',
    '## Personal Care', '1. shampoo',
    '',
    '## Baby & Pets', '1. diapers', '2. cat litter',
  ].join('\n'));
});

test('a plain title line and "Label:" lines stay on top', function () {
  var r = K.sortShoppingList(['Shopping 🛒', '**Fruit & Veg**', '- apples', '- milk', 'For the party:', '- ice'].join('\n'));
  assert.strictEqual(r.text, ['Shopping 🛒', 'For the party:', '', '## Produce', '- apples', '', '## Dairy & Eggs', '- milk', '', '## Frozen', '- ice'].join('\n'));
  assert.strictEqual(r.items, 3);
});

test('store sections stay, each sorted under its own heading level', function () {
  var r = K.sortShoppingList(['## Costco', '* paper towels', '* salmon', '* paper towels', '', '## Farmers market', '* eggs', '* kale', '* honey'].join('\n'));
  assert.strictEqual(r.text, [
    '## Costco', '',
    '### Meat & Seafood', '* salmon', '',
    '### Household', '* paper towels', '',
    '## Farmers market', '',
    '### Produce', '* kale', '',
    '### Dairy & Eggs', '* eggs', '',
    '### Pantry', '* honey',
  ].join('\n'));
});

test('merging: compatible quantities sum, incompatible stay apart, bare duplicates fold', function () {
  var t = function (lines) { return K.sortShoppingList(lines.join('\n')).text.split('\n').filter(function (l) { return l && l[0] !== '#'; }); };
  assert.deepStrictEqual(t(['- 1 lb chicken', '- 8 oz chicken']), ['- 1.5 lb chicken']);
  assert.deepStrictEqual(t(['- 2 L milk', '- 500 ml milk']), ['- 2.5 L milk']);
  assert.deepStrictEqual(t(['- 1 lb chicken', '- 200 g chicken']), ['- 1 lb chicken', '- 200 g chicken']);
  assert.deepStrictEqual(t(['- milk x2', '- milk x1']), ['- milk x3']);
  assert.deepStrictEqual(t(['- 2 bags of rice', '- 1 bag of rice']), ['- 3 bags of rice']);
  assert.deepStrictEqual(t(['- 1 apple', '- 2 apples']), ['- 3 apples']);
  assert.deepStrictEqual(t(['- a dozen eggs', '- 6 eggs']), ['- 1.5 dozen eggs']);
  assert.deepStrictEqual(t(['- apples', '- 3 apples']), ['- 3 apples']);
  assert.deepStrictEqual(t(['- Apples', '- apple']), ['- Apples']);
  assert.deepStrictEqual(t(['- [x] milk', '- [ ] milk']), ['- [ ] milk', '- [x] milk']); // bought ≠ still needed
  assert.deepStrictEqual(t(['- milk (oat)', '- milk']), ['- milk (oat)', '- milk']);
});

test('a selection under an existing heading gets one level deeper; aisle headings are rebuilt', function () {
  assert.strictEqual(K.headingLevelAbove('# Week\n\n## Shopping\n'), 2);
  assert.strictEqual(K.headingLevelAbove('no headings'), 0);
  assert.strictEqual(K.headingLevelAbove('## Shopping\n### Produce\n'), 2); // aisle headings don't count
  var r = K.sortShoppingList('- eggs\n- kale', { baseLevel: 2 });
  assert.strictEqual(r.text, '### Produce\n- kale\n\n### Dairy & Eggs\n- eggs');
  var again = K.sortShoppingList('### Produce\n- kale\n- milk\n**Dairy**\n- eggs');
  assert.strictEqual(again.text, '## Produce\n- kale\n\n## Dairy & Eggs\n- milk\n- eggs');
});

test('trailing newline kept, empty input harmless', function () {
  assert.strictEqual(K.sortShoppingList('- milk\n- kale\n').text, '## Produce\n- kale\n\n## Dairy & Eggs\n- milk\n');
  assert.deepStrictEqual(K.sortShoppingList('').items, 0);
});

// =========================================================================== conversion
test('convert US → metric (density table for dry goods, spoons kept, °F → °C)', function () {
  var us = ['- 2 cups all-purpose flour', '- 1 cup sugar', '- 1/2 cup butter, softened', '- 1 cup milk', '- 2 tsp vanilla', '- 8 oz cream cheese', '- 1 lb ground beef', 'Bake at 350°F for 25 minutes in a 9-inch pan.'].join('\n');
  var r = K.convertText(us);
  assert.strictEqual(r.to, 'metric');
  assert.strictEqual(r.text, ['- 250 g all-purpose flour', '- 200 g sugar', '- 115 g butter, softened', '- 235 ml milk', '- 2 tsp vanilla', '- 225 g cream cheese', '- 455 g ground beef', 'Bake at 180°C for 25 minutes in a 9-inch pan.'].join('\n'));
});

test('convert metric → US (cups from grams via density, oz / lb, °C → °F)', function () {
  var m = ['- 250 g plain flour', '- 200 g caster sugar', '- 125 g butter', '- 300 ml milk', '- 1 kg potatoes', '- 500 g chicken', '- 15 ml oil', 'Bake at 180°C (160 °C fan) for 30 mins.'].join('\n');
  var r = K.convertText(m);
  assert.strictEqual(r.to, 'us');
  assert.strictEqual(r.text, ['- 2 cups plain flour', '- 1 cup caster sugar', '- 1/2 cup butter', '- 1 1/4 cups milk', '- 2 1/4 lb potatoes', '- 1 lb chicken', '- 1 tbsp oil', 'Bake at 350°F (325 °F fan) for 30 mins.'].join('\n'));
});

test('unitSystem picks the direction; explicit direction wins', function () {
  assert.strictEqual(K.unitSystem('2 cups flour\n1 lb beef\n200 g sugar').to, 'metric');
  assert.strictEqual(K.unitSystem('200 g sugar\n1 l milk\n1 cup rice').to, 'us');
  assert.strictEqual(K.convertText('400°F oven', 'metric').text, '200°C oven');
  assert.strictEqual(K.convertText('no quantities here').changed, 0);
});

// =========================================================================== editor helper
test('minimalChange: smallest single replacement', function () {
  assert.deepStrictEqual(K.minimalChange('- 2 cups flour\n- 1 egg', '- 4 cups flour\n- 2 eggs'), { from: 2, to: 22, insert: '4 cups flour\n- 2 eggs' });
  assert.deepStrictEqual(K.minimalChange('abc', 'abc'), { from: 3, to: 3, insert: '' });
  assert.deepStrictEqual(K.minimalChange('serves 4', 'serves 8'), { from: 7, to: 8, insert: '8' });
});

console.log(passed + ' tests passed' + (process.exitCode ? ' (with failures)' : ''));
