/* Calc engine — the shared expression + units evaluator behind the
 * Calculator, Unit Converter and Inline-math modules.
 *
 * SAFE: no eval / Function. A hand-written tokenizer feeds a recursive-descent
 * parser that builds a small AST, which is then evaluated over "quantities"
 * ({v: value in SI base units, d: dimension vector, h: display-unit hint}).
 *
 * Supports: 1,234.5 · 1e6 · 0x1F · 0b101 · 1_000 · + − × ÷ * / ^ ** · mod ·
 * percent (200 + 10% = 220, 10% of 200 = 20, 20% off 50 = 40, 50 as % of 200)
 * · ! · implicit multiplication (2pi, 3(4+5)) · functions · constants ·
 * variables (x = 5, ans) · units with conversion (5 km to mi, 3 ft + 2 in in
 * cm, 100 °F in °C, 60 mph in km/h, 8 L/100km in mpg) · hex/bin/oct output.
 *
 * Loaded lazily via a <script> tag by whichever module needs it first and
 * defines window.__cadeCalcEngine exactly once (re-running is a no-op). */
(function (root) {
  'use strict';
  if (!root || root.__cadeCalcEngine) return;

  // ---- dimensions -----------------------------------------------------------
  // [Length, Mass, Time, Temperature, Current, Data(bits)]. Angles are
  // dimensionless (radian = 1), so sin(30 deg) just works.
  var DK = 'LMTKAD';
  var ZERO = [0, 0, 0, 0, 0, 0];
  function parseDims(s) {
    var d = ZERO.slice();
    String(s).replace(/([LMTKAD])(-?\d*)/g, function (_, k, n) { d[DK.indexOf(k)] += n === '' ? 1 : +n; return ''; });
    return d;
  }
  function dkey(d) { return d.join(','); }
  function isZero(d) { for (var i = 0; i < 6; i++) if (d[i]) return false; return true; }
  function dimsEq(a, b) { for (var i = 0; i < 6; i++) if (Math.abs(a[i] - b[i]) > 1e-9) return false; return true; }
  function dimsAdd(a, b, s) { var r = []; for (var i = 0; i < 6; i++) r.push(a[i] + s * b[i]); return r; }
  function dimsScale(a, k) { var r = []; for (var i = 0; i < 6; i++) r.push(a[i] * k); return r; }

  // ---- unit table -------------------------------------------------------------
  // [id, display symbol, factor → SI, dims, category, label, aliases, plural, offset]
  // Aliases are exact-case; all-lowercase word aliases (3+ letters, or with a
  // space) are also matched case-insensitively. Display symbols re-parse to
  // the same unit, so an inserted result can be computed with again.
  var F_DEGF = 5 / 9;
  var RAW = [
    // length
    ['nm', 'nm', 1e-9, 'L', 'length', 'Nanometre', 'nm|nanometer|nanometers|nanometre|nanometres'],
    ['um', '\u00b5m', 1e-6, 'L', 'length', 'Micrometre', '\u00b5m|\u03bcm|um|micron|microns|micrometer|micrometers|micrometre|micrometres'],
    ['mm', 'mm', 1e-3, 'L', 'length', 'Millimetre', 'mm|millimeter|millimeters|millimetre|millimetres'],
    ['cm', 'cm', 1e-2, 'L', 'length', 'Centimetre', 'cm|centimeter|centimeters|centimetre|centimetres'],
    ['dm', 'dm', 0.1, 'L', 'length', 'Decimetre', 'dm|decimeter|decimeters|decimetre|decimetres'],
    ['m', 'm', 1, 'L', 'length', 'Metre', 'm|meter|meters|metre|metres'],
    ['km', 'km', 1000, 'L', 'length', 'Kilometre', 'km|kms|kilometer|kilometers|kilometre|kilometres|klick|klicks'],
    ['in', 'in', 0.0254, 'L', 'length', 'Inch', 'in|inch|inches'],
    ['ft', 'ft', 0.3048, 'L', 'length', 'Foot', 'ft|foot|feet'],
    ['yd', 'yd', 0.9144, 'L', 'length', 'Yard', 'yd|yds|yard|yards'],
    ['mi', 'mi', 1609.344, 'L', 'length', 'Mile', 'mi|mile|miles'],
    ['nmi', 'nmi', 1852, 'L', 'length', 'Nautical mile', 'nmi|NM|nautical mile|nautical miles'],
    ['thou', 'thou', 2.54e-5, 'L', 'length', 'Thou (mil)', 'thou'],
    ['fathom', 'fathom', 1.8288, 'L', 'length', 'Fathom', 'fathom|fathoms', 'fathoms'],
    ['furlong', 'furlong', 201.168, 'L', 'length', 'Furlong', 'furlong|furlongs', 'furlongs'],
    ['ang', '\u00c5', 1e-10, 'L', 'length', '\u00c5ngstr\u00f6m', '\u00c5|angstrom|angstroms'],
    ['au', 'au', 149597870700, 'L', 'length', 'Astronomical unit', 'au|AU|astronomical unit|astronomical units'],
    ['ly', 'ly', 9460730472580800, 'L', 'length', 'Light-year', 'ly|lightyear|lightyears|light year|light years'],
    ['pc', 'pc', 3.0856775814913673e16, 'L', 'length', 'Parsec', 'pc|parsec|parsecs'],
    // mass
    ['ug', '\u00b5g', 1e-9, 'M', 'mass', 'Microgram', '\u00b5g|\u03bcg|ug|mcg|microgram|micrograms'],
    ['mg', 'mg', 1e-6, 'M', 'mass', 'Milligram', 'mg|milligram|milligrams'],
    ['g', 'g', 1e-3, 'M', 'mass', 'Gram', 'g|gm|gms|gram|grams|gramme|grammes'],
    ['kg', 'kg', 1, 'M', 'mass', 'Kilogram', 'kg|kgs|kilogram|kilograms|kilo|kilos'],
    ['t', 't', 1000, 'M', 'mass', 'Tonne (metric)', 't|tonne|tonnes|metric ton|metric tons'],
    ['gr', 'gr', 6.479891e-5, 'M', 'mass', 'Grain', 'gr|grain|grains'],
    ['ct', 'ct', 2e-4, 'M', 'mass', 'Carat', 'ct|carat|carats'],
    ['oz', 'oz', 0.028349523125, 'M', 'mass', 'Ounce', 'oz|ounce|ounces'],
    ['lb', 'lb', 0.45359237, 'M', 'mass', 'Pound', 'lb|lbs|pound|pounds'],
    ['st', 'st', 6.35029318, 'M', 'mass', 'Stone', 'st|stone|stones'],
    ['ton', 'ton', 907.18474, 'M', 'mass', 'US ton (short)', 'ton|tons|short ton|short tons|us ton|us tons', 'tons'],
    ['lton', 'long ton', 1016.0469088, 'M', 'mass', 'UK ton (long)', 'long ton|long tons|uk ton|uk tons|imperial ton', 'long tons'],
    // time
    ['ns', 'ns', 1e-9, 'T', 'time', 'Nanosecond', 'ns|nanosecond|nanoseconds'],
    ['us', '\u00b5s', 1e-6, 'T', 'time', 'Microsecond', '\u00b5s|\u03bcs|microsecond|microseconds'],
    ['ms', 'ms', 1e-3, 'T', 'time', 'Millisecond', 'ms|msec|msecs|millisecond|milliseconds'],
    ['s', 's', 1, 'T', 'time', 'Second', 's|sec|secs|second|seconds'],
    ['min', 'min', 60, 'T', 'time', 'Minute', 'min|mins|minute|minutes'],
    ['h', 'h', 3600, 'T', 'time', 'Hour', 'h|hr|hrs|hour|hours'],
    ['day', 'day', 86400, 'T', 'time', 'Day', 'd|day|days', 'days'],
    ['week', 'week', 604800, 'T', 'time', 'Week', 'wk|wks|week|weeks', 'weeks'],
    ['fortnight', 'fortnight', 1209600, 'T', 'time', 'Fortnight', 'fortnight|fortnights', 'fortnights'],
    ['month', 'month', 2629746, 'T', 'time', 'Month (avg)', 'mo|mos|month|months', 'months'],
    ['year', 'year', 31556952, 'T', 'time', 'Year (avg)', 'yr|yrs|year|years', 'years'],
    ['decade', 'decade', 315569520, 'T', 'time', 'Decade', 'decade|decades', 'decades'],
    ['century', 'century', 3155695200, 'T', 'time', 'Century', 'century|centuries', 'centuries'],
    // area
    ['mm2', 'mm\u00b2', 1e-6, 'L2', 'area', 'Square millimetre', 'mm2|sq mm|square millimeter|square millimeters|square millimetre|square millimetres'],
    ['cm2', 'cm\u00b2', 1e-4, 'L2', 'area', 'Square centimetre', 'cm2|sq cm|square centimeter|square centimeters|square centimetre|square centimetres'],
    ['m2', 'm\u00b2', 1, 'L2', 'area', 'Square metre', 'm2|sqm|sq m|square meter|square meters|square metre|square metres'],
    ['ha', 'ha', 1e4, 'L2', 'area', 'Hectare', 'ha|hectare|hectares'],
    ['km2', 'km\u00b2', 1e6, 'L2', 'area', 'Square kilometre', 'km2|sqkm|sq km|square kilometer|square kilometers|square kilometre|square kilometres'],
    ['in2', 'in\u00b2', 0.00064516, 'L2', 'area', 'Square inch', 'in2|sqin|sq in|square inch|square inches'],
    ['ft2', 'ft\u00b2', 0.09290304, 'L2', 'area', 'Square foot', 'ft2|sqft|sq ft|square foot|square feet'],
    ['yd2', 'yd\u00b2', 0.83612736, 'L2', 'area', 'Square yard', 'yd2|sqyd|sq yd|square yard|square yards'],
    ['acre', 'acre', 4046.8564224, 'L2', 'area', 'Acre', 'ac|acre|acres', 'acres'],
    ['mi2', 'mi\u00b2', 2589988.110336, 'L2', 'area', 'Square mile', 'mi2|sqmi|sq mi|square mile|square miles'],
    // volume (incl. cooking)
    ['ml', 'ml', 1e-6, 'L3', 'volume', 'Millilitre', 'ml|mL|milliliter|milliliters|millilitre|millilitres'],
    ['cl', 'cl', 1e-5, 'L3', 'volume', 'Centilitre', 'cl|cL|centiliter|centiliters|centilitre|centilitres'],
    ['dl', 'dl', 1e-4, 'L3', 'volume', 'Decilitre', 'dl|dL|deciliter|deciliters|decilitre|decilitres'],
    ['l', 'L', 1e-3, 'L3', 'volume', 'Litre', 'l|L|ltr|liter|liters|litre|litres'],
    ['m3', 'm\u00b3', 1, 'L3', 'volume', 'Cubic metre', 'm3|cu m|cubic meter|cubic meters|cubic metre|cubic metres'],
    ['cm3', 'cm\u00b3', 1e-6, 'L3', 'volume', 'Cubic centimetre', 'cm3|cc|cu cm|cubic centimeter|cubic centimeters|cubic centimetre|cubic centimetres'],
    ['in3', 'in\u00b3', 1.6387064e-5, 'L3', 'volume', 'Cubic inch', 'in3|cu in|cubic inch|cubic inches'],
    ['ft3', 'ft\u00b3', 0.028316846592, 'L3', 'volume', 'Cubic foot', 'ft3|cu ft|cubic foot|cubic feet'],
    ['yd3', 'yd\u00b3', 0.764554857984, 'L3', 'volume', 'Cubic yard', 'yd3|cu yd|cubic yard|cubic yards'],
    ['tsp', 'tsp', 4.92892159375e-6, 'L3', 'volume', 'Teaspoon (US)', 'tsp|tsps|teaspoon|teaspoons'],
    ['tbsp', 'tbsp', 1.478676478125e-5, 'L3', 'volume', 'Tablespoon (US)', 'tbsp|Tbsp|tbsps|tbs|tablespoon|tablespoons'],
    ['floz', 'fl oz', 2.95735295625e-5, 'L3', 'volume', 'Fluid ounce (US)', 'floz|fl oz|fluid ounce|fluid ounces|us fl oz'],
    ['cup', 'cup', 2.365882365e-4, 'L3', 'volume', 'Cup (US)', 'cup|cups|us cup|us cups', 'cups'],
    ['mcup', 'metric cup', 2.5e-4, 'L3', 'volume', 'Cup (metric)', 'metric cup|metric cups', 'metric cups'],
    ['pt', 'pt', 4.73176473e-4, 'L3', 'volume', 'Pint (US)', 'pt|pint|pints|us pint|us pints|us pt'],
    ['qt', 'qt', 9.46352946e-4, 'L3', 'volume', 'Quart (US)', 'qt|quart|quarts|us quart|us quarts|us qt'],
    ['gal', 'gal', 3.785411784e-3, 'L3', 'volume', 'Gallon (US)', 'gal|gals|gallon|gallons|us gal|us gallon|us gallons'],
    ['ukfloz', 'UK fl oz', 2.84130625e-5, 'L3', 'volume', 'Fluid ounce (UK)', 'uk fl oz|imp fl oz|imperial fluid ounce|imperial fluid ounces'],
    ['ukpt', 'UK pt', 5.6826125e-4, 'L3', 'volume', 'Pint (UK)', 'uk pt|uk pint|uk pints|imp pt|imperial pint|imperial pints'],
    ['ukqt', 'UK qt', 1.1365225e-3, 'L3', 'volume', 'Quart (UK)', 'uk qt|uk quart|uk quarts|imperial quart|imperial quarts'],
    ['ukgal', 'UK gal', 4.54609e-3, 'L3', 'volume', 'Gallon (UK)', 'uk gal|uk gallon|uk gallons|imp gal|imperial gallon|imperial gallons'],
    ['bbl', 'bbl', 0.158987294928, 'L3', 'volume', 'Barrel (oil)', 'bbl|barrel|barrels'],
    // temperature (affine: K = value × factor + offset)
    ['K', 'K', 1, 'K', 'temperature', 'Kelvin', 'K|kelvin|kelvins', null, 0],
    ['degC', '\u00b0C', 1, 'K', 'temperature', 'Celsius', '\u00b0C|C|degC|celsius|centigrade', null, 273.15],
    ['degF', '\u00b0F', F_DEGF, 'K', 'temperature', 'Fahrenheit', '\u00b0F|F|degF|fahrenheit', null, 459.67 * F_DEGF],
    ['degR', '\u00b0R', F_DEGF, 'K', 'temperature', 'Rankine', '\u00b0R|degR|rankine', null, 0],
    // speed
    ['mps', 'm/s', 1, 'LT-1', 'speed', 'Metre/second', 'mps'],
    ['kmh', 'km/h', 1 / 3.6, 'LT-1', 'speed', 'Kilometre/hour', 'kph|kmh|kmph'],
    ['mph', 'mph', 0.44704, 'LT-1', 'speed', 'Mile/hour', 'mph|MPH'],
    ['fps', 'ft/s', 0.3048, 'LT-1', 'speed', 'Foot/second', 'ftps'],
    ['kn', 'kn', 1852 / 3600, 'LT-1', 'speed', 'Knot', 'kn|kt|kts|knot|knots'],
    ['mach', 'mach', 340.29, 'LT-1', 'speed', 'Mach (sea level)', 'mach|Mach'],
    // data (lower-case kb/mb/gb are read as BYTES — how people casually write file sizes)
    ['bit', 'bit', 1, 'D', 'data', 'Bit', 'b|bit|bits'],
    ['B', 'B', 8, 'D', 'data', 'Byte', 'B|byte|bytes'],
    ['kbit', 'kbit', 1e3, 'D', 'data', 'Kilobit', 'Kb|kbit|kilobit|kilobits'],
    ['kB', 'kB', 8e3, 'D', 'data', 'Kilobyte', 'kB|KB|kb|kilobyte|kilobytes'],
    ['KiB', 'KiB', 8 * 1024, 'D', 'data', 'Kibibyte', 'KiB|kib|kibibyte|kibibytes'],
    ['Mbit', 'Mbit', 1e6, 'D', 'data', 'Megabit', 'Mb|Mbit|megabit|megabits'],
    ['MB', 'MB', 8e6, 'D', 'data', 'Megabyte', 'MB|mb|megabyte|megabytes'],
    ['MiB', 'MiB', 8 * 1048576, 'D', 'data', 'Mebibyte', 'MiB|mib|mebibyte|mebibytes'],
    ['Gbit', 'Gbit', 1e9, 'D', 'data', 'Gigabit', 'Gb|Gbit|gigabit|gigabits'],
    ['GB', 'GB', 8e9, 'D', 'data', 'Gigabyte', 'GB|gb|gigabyte|gigabytes'],
    ['GiB', 'GiB', 8 * 1073741824, 'D', 'data', 'Gibibyte', 'GiB|gib|gibibyte|gibibytes'],
    ['Tbit', 'Tbit', 1e12, 'D', 'data', 'Terabit', 'Tb|Tbit|terabit|terabits'],
    ['TB', 'TB', 8e12, 'D', 'data', 'Terabyte', 'TB|tb|terabyte|terabytes'],
    ['TiB', 'TiB', 8 * 1099511627776, 'D', 'data', 'Tebibyte', 'TiB|tib|tebibyte|tebibytes'],
    ['PB', 'PB', 8e15, 'D', 'data', 'Petabyte', 'PB|pb|petabyte|petabytes'],
    ['PiB', 'PiB', 8 * 1125899906842624, 'D', 'data', 'Pebibyte', 'PiB|pib|pebibyte|pebibytes'],
    // data rate
    ['bps', 'bit/s', 1, 'DT-1', 'datarate', 'Bit/second', 'bps'],
    ['kbps', 'kbit/s', 1e3, 'DT-1', 'datarate', 'Kilobit/second', 'kbps|Kbps'],
    ['Mbps', 'Mbit/s', 1e6, 'DT-1', 'datarate', 'Megabit/second', 'Mbps|mbps'],
    ['Gbps', 'Gbit/s', 1e9, 'DT-1', 'datarate', 'Gigabit/second', 'Gbps|gbps'],
    ['Bps', 'B/s', 8, 'DT-1', 'datarate', 'Byte/second', 'Bps'],
    ['kBps', 'kB/s', 8e3, 'DT-1', 'datarate', 'Kilobyte/second', 'kBps|KBps'],
    ['MBps', 'MB/s', 8e6, 'DT-1', 'datarate', 'Megabyte/second', 'MBps'],
    ['GBps', 'GB/s', 8e9, 'DT-1', 'datarate', 'Gigabyte/second', 'GBps'],
    // pressure
    ['Pa', 'Pa', 1, 'ML-1T-2', 'pressure', 'Pascal', 'Pa|pascal|pascals'],
    ['hPa', 'hPa', 100, 'ML-1T-2', 'pressure', 'Hectopascal', 'hPa|hectopascal|hectopascals'],
    ['kPa', 'kPa', 1e3, 'ML-1T-2', 'pressure', 'Kilopascal', 'kPa|kilopascal|kilopascals'],
    ['MPa', 'MPa', 1e6, 'ML-1T-2', 'pressure', 'Megapascal', 'MPa|megapascal|megapascals'],
    ['bar', 'bar', 1e5, 'ML-1T-2', 'pressure', 'Bar', 'bar|bars'],
    ['mbar', 'mbar', 100, 'ML-1T-2', 'pressure', 'Millibar', 'mbar|millibar|millibars'],
    ['atm', 'atm', 101325, 'ML-1T-2', 'pressure', 'Atmosphere', 'atm|atmosphere|atmospheres'],
    ['psi', 'psi', 6894.757293168361, 'ML-1T-2', 'pressure', 'Pound/sq inch', 'psi|PSI'],
    ['mmHg', 'mmHg', 133.322387415, 'ML-1T-2', 'pressure', 'Millimetre of mercury', 'mmHg|mmhg'],
    ['inHg', 'inHg', 3386.389, 'ML-1T-2', 'pressure', 'Inch of mercury', 'inHg|inhg'],
    ['torr', 'Torr', 101325 / 760, 'ML-1T-2', 'pressure', 'Torr', 'Torr|torr'],
    // energy
    ['J', 'J', 1, 'ML2T-2', 'energy', 'Joule', 'J|joule|joules'],
    ['kJ', 'kJ', 1e3, 'ML2T-2', 'energy', 'Kilojoule', 'kJ|kilojoule|kilojoules'],
    ['MJ', 'MJ', 1e6, 'ML2T-2', 'energy', 'Megajoule', 'MJ|megajoule|megajoules'],
    ['GJ', 'GJ', 1e9, 'ML2T-2', 'energy', 'Gigajoule', 'GJ|gigajoule|gigajoules'],
    ['cal', 'cal', 4.184, 'ML2T-2', 'energy', 'Calorie', 'cal|calorie|calories'],
    ['kcal', 'kcal', 4184, 'ML2T-2', 'energy', 'Kilocalorie (food Cal)', 'kcal|Cal|kilocalorie|kilocalories'],
    ['Wh', 'Wh', 3600, 'ML2T-2', 'energy', 'Watt-hour', 'Wh|watt hour|watt hours'],
    ['kWh', 'kWh', 3.6e6, 'ML2T-2', 'energy', 'Kilowatt-hour', 'kWh|kwh|kilowatt hour|kilowatt hours'],
    ['MWh', 'MWh', 3.6e9, 'ML2T-2', 'energy', 'Megawatt-hour', 'MWh|megawatt hour|megawatt hours'],
    ['BTU', 'BTU', 1055.05585262, 'ML2T-2', 'energy', 'British thermal unit', 'BTU|Btu|btu'],
    ['therm', 'therm', 105505585.262, 'ML2T-2', 'energy', 'Therm', 'therm|therms', 'therms'],
    ['eV', 'eV', 1.602176634e-19, 'ML2T-2', 'energy', 'Electronvolt', 'eV|electronvolt|electronvolts'],
    ['ftlbf', 'ft\u00b7lbf', 1.3558179483314004, 'ML2T-2', 'energy', 'Foot-pound', 'ftlbf|ftlb|ft lbf|foot pound|foot pounds'],
    ['erg', 'erg', 1e-7, 'ML2T-2', 'energy', 'Erg', 'erg|ergs'],
    // power
    ['mW', 'mW', 1e-3, 'ML2T-3', 'power', 'Milliwatt', 'mW|milliwatt|milliwatts'],
    ['W', 'W', 1, 'ML2T-3', 'power', 'Watt', 'W|watt|watts'],
    ['kW', 'kW', 1e3, 'ML2T-3', 'power', 'Kilowatt', 'kW|kilowatt|kilowatts'],
    ['MW', 'MW', 1e6, 'ML2T-3', 'power', 'Megawatt', 'MW|megawatt|megawatts'],
    ['GW', 'GW', 1e9, 'ML2T-3', 'power', 'Gigawatt', 'GW|gigawatt|gigawatts'],
    ['hp', 'hp', 745.69987158227022, 'ML2T-3', 'power', 'Horsepower (mech.)', 'hp|horsepower'],
    ['PS', 'PS', 735.49875, 'ML2T-3', 'power', 'Metric horsepower', 'PS|metric hp|metric horsepower'],
    ['BTUh', 'BTU/h', 1055.05585262 / 3600, 'ML2T-3', 'power', 'BTU/hour', 'BTUh|btuh'],
    // force
    ['N', 'N', 1, 'MLT-2', 'force', 'Newton', 'N|newton|newtons'],
    ['kN', 'kN', 1e3, 'MLT-2', 'force', 'Kilonewton', 'kN|kilonewton|kilonewtons'],
    ['dyn', 'dyn', 1e-5, 'MLT-2', 'force', 'Dyne', 'dyn|dyne|dynes'],
    ['lbf', 'lbf', 4.4482216152605, 'MLT-2', 'force', 'Pound-force', 'lbf|pound force'],
    ['kgf', 'kgf', 9.80665, 'MLT-2', 'force', 'Kilogram-force', 'kgf|kp|kilogram force'],
    // angle (dimensionless; radian = 1)
    ['rad', 'rad', 1, '', 'angle', 'Radian', 'rad|rads|radian|radians'],
    ['deg', '\u00b0', Math.PI / 180, '', 'angle', 'Degree', 'deg|degs|degree|degrees|\u00b0'],
    ['grad', 'grad', Math.PI / 200, '', 'angle', 'Gradian', 'grad|grads|gradian|gradians|gon|gons'],
    ['arcmin', 'arcmin', Math.PI / 10800, '', 'angle', 'Arcminute', 'arcmin|arcmins|arcminute|arcminutes'],
    ['arcsec', 'arcsec', Math.PI / 648000, '', 'angle', 'Arcsecond', 'arcsec|arcsecs|arcsecond|arcseconds'],
    ['turn', 'turn', 2 * Math.PI, '', 'angle', 'Turn', 'turn|turns|rev|revs|revolution|revolutions', 'turns'],
    // frequency
    ['Hz', 'Hz', 1, 'T-1', 'frequency', 'Hertz', 'Hz|hz|hertz'],
    ['kHz', 'kHz', 1e3, 'T-1', 'frequency', 'Kilohertz', 'kHz|khz|kilohertz'],
    ['MHz', 'MHz', 1e6, 'T-1', 'frequency', 'Megahertz', 'MHz|mhz|megahertz'],
    ['GHz', 'GHz', 1e9, 'T-1', 'frequency', 'Gigahertz', 'GHz|ghz|gigahertz'],
    ['THz', 'THz', 1e12, 'T-1', 'frequency', 'Terahertz', 'THz|thz|terahertz'],
    ['rpm', 'rpm', 1 / 60, 'T-1', 'frequency', 'Revolutions/minute', 'rpm|RPM'],
    ['bpm', 'bpm', 1 / 60, 'T-1', 'frequency', 'Beats/minute', 'bpm|BPM'],
    // fuel economy — L/100km is the INVERSE dimension of mpg / km/L
    ['mpg', 'mpg', 1609.344 / 3.785411784e-3, 'L-2', 'fuel', 'Miles/gallon (US)', 'mpg|MPG|us mpg|mpg us'],
    ['mpguk', 'mpg UK', 1609.344 / 4.54609e-3, 'L-2', 'fuel', 'Miles/gallon (UK)', 'mpguk|mpg uk|uk mpg|mpg imp'],
    ['kmpl', 'km/L', 1e6, 'L-2', 'fuel', 'Kilometres/litre', 'kmpl|kpl'],
    ['l100km', 'L/100km', 1e-8, 'L2', 'fuel', 'Litres/100 km', 'L/100km|l/100km|lp100km']
  ];

  var UNITS = [], BYID = {}, EXACT = {}, CI = {}, MW = {}, BYDIMS = {};
  RAW.forEach(function (r) {
    var u = { id: r[0], sym: r[1], f: r[2], d: parseDims(r[3]), cat: r[4], label: r[5], plural: r[7] || null, off: r[8] || 0, affine: r[8] != null };
    u.dk = dkey(u.d);
    UNITS.push(u); BYID[u.id] = u;
    (BYDIMS[u.dk] || (BYDIMS[u.dk] = [])).push(u);
    r[6].split('|').forEach(function (a) {
      if (!EXACT[a]) EXACT[a] = u;
      var lo = a.toLowerCase();
      if (a.indexOf(' ') !== -1) { MW[lo] = 1; if (!CI[lo]) CI[lo] = u; }
      else if (a === lo && /^[a-z]{3,}$/.test(a) && !CI[lo]) CI[lo] = u;
    });
  });
  function findUnit(name) {
    if (!name) return null;
    return EXACT[name] || CI[name.toLowerCase()] || null;
  }
  var CAT_NAMES = {
    length: 'length', mass: 'mass', time: 'time', area: 'area', volume: 'volume', temperature: 'temperature',
    speed: 'speed', data: 'data', datarate: 'data rate', pressure: 'pressure', energy: 'energy', power: 'power',
    force: 'force', angle: 'angle', frequency: 'frequency', fuel: 'fuel economy'
  };
  function dimsName(d) {
    if (isZero(d)) return 'a plain number';
    var us = BYDIMS[dkey(d)];
    if (us) return CAT_NAMES[us[0].cat] || us[0].cat;
    return renderHint(siHint(d), 2) || 'that unit';
  }
  // SI base units for results whose unit hint got lost (e.g. sqrt of an area).
  var BASE = [BYID.m, BYID.kg, BYID.s, BYID.K, { id: 'A', sym: 'A', f: 1, d: parseDims('A'), dk: '0,0,0,0,1,0' }, BYID.bit];
  function siHint(d) {
    var h = [];
    for (var i = 0; i < 6; i++) if (d[i]) h.push([BASE[i], d[i]]);
    return h.length ? h : null;
  }

  // ---- constants & functions --------------------------------------------------
  var CONSTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI, phi: (1 + Math.sqrt(5)) / 2 };
  var KEYWORDS = { to: 1, as: 1, of: 1, off: 1, mod: 1, per: 1 };
  var CONV_WORDS = { to: 1, in: 1, as: 1 };

  function CalcError(msg) { this.message = msg; }
  function fail(msg) { throw new CalcError(msg); }

  // ---- tokenizer --------------------------------------------------------------
  var SUP = { '\u2070': 0, '\u00b9': 1, '\u00b2': 2, '\u00b3': 3, '\u2074': 4, '\u2075': 5, '\u2076': 6, '\u2077': 7, '\u2078': 8, '\u2079': 9 };
  var OPMAP = {
    '+': '+', '-': '-', '\u2212': '-', '\u2013': '-', '*': '*', '\u00d7': '*', '\u22c5': '*', '\u00b7': '*', '\u2219': '*',
    '/': '/', '\u00f7': '/', '\u2215': '/', '^': '^', '%': '%', '!': '!', '(': '(', ')': ')', ',': ',', '=': '='
  };
  function isDigit(c) { return c >= '0' && c <= '9'; }
  function isIdStart(c) { return /[A-Za-z_\u00b5\u03bc\u00c5]/.test(c); }
  function isIdChar(c) { return /[A-Za-z0-9_\u00b5\u03bc]/.test(c); }
  function isOperandTok(t) { return t && (t.k === 'num' || (t.k === 'id' && !KEYWORDS[t.s]) || (t.k === 'op' && (t.s === ')' || t.s === '!' || t.s === '%'))); }

  function tokenize(src) {
    var toks = [], i = 0, n = src.length, paren = [];
    function push(k, s, v, start) { var t = { k: k, s: s, p: start, sp: start > 0 && /\s/.test(src.charAt(start - 1)) }; if (v !== undefined) t.v = v; toks.push(t); return t; }
    function readIdent(j) { var k = j + 1; while (k < n && isIdChar(src.charAt(k))) k++; return k; }
    while (i < n) {
      var c = src.charAt(i), start = i;
      if (/\s/.test(c)) { i++; continue; }
      // numbers
      if (isDigit(c) || (c === '.' && isDigit(src.charAt(i + 1)))) {
        var c1 = src.charAt(i + 1);
        if (c === '0' && /[xXbBoO]/.test(c1)) {
          var base = { x: 16, b: 2, o: 8 }[c1.toLowerCase()];
          var mm = (base === 16 ? /^[0-9a-fA-F][0-9a-fA-F_]*/ : base === 2 ? /^[01][01_]*/ : /^[0-7][0-7_]*/).exec(src.slice(i + 2));
          if (mm && !isIdChar(src.charAt(i + 2 + mm[0].length))) {
            push('num', src.slice(i, i + 2 + mm[0].length), parseInt(mm[0].replace(/_/g, ''), base), start);
            i += 2 + mm[0].length; continue;
          }
        }
        // Fraction literal "1/2 cup": only when an operand starts here and a
        // unit follows, so "1/2 cup in tbsp" means half a cup.
        var fm = /^(\d+)\/(\d+)\s*([A-Za-z\u00b5\u03bc\u00b0][A-Za-z0-9_]*)/.exec(src.slice(i));
        if (fm && !isOperandTok(toks[toks.length - 1]) && findUnit(fm[3]) && src.charAt(i + fm[0].length) !== '(' && +fm[2] !== 0) {
          push('num', fm[1] + '/' + fm[2], +fm[1] / +fm[2], start);
          i += fm[1].length + 1 + fm[2].length; continue;
        }
        var j = i;
        while (j < n && (isDigit(src.charAt(j)) || (src.charAt(j) === '_' && isDigit(src.charAt(j + 1)) && j > i))) j++;
        var intRaw = src.slice(i, j);
        // Thousands separators, except inside a function call's argument list
        // (max(1,234) is two arguments).
        if (paren[paren.length - 1] !== 'call' && intRaw.length && intRaw.length <= 3 && intRaw.indexOf('_') === -1) {
          while (src.charAt(j) === ',' && /^\d{3}(?!\d)/.test(src.slice(j + 1, j + 5))) j += 4;
        }
        if (src.charAt(j) === '.' && isDigit(src.charAt(j + 1))) {
          j++;
          while (j < n && (isDigit(src.charAt(j)) || (src.charAt(j) === '_' && isDigit(src.charAt(j + 1))))) j++;
        }
        var em = /^[eE][+-]?\d+/.exec(src.slice(j));
        if (em) j += em[0].length;
        var text = src.slice(i, j);
        push('num', text, parseFloat(text.replace(/[,_]/g, '')), start);
        i = j;
        // "3x4" — an x glued between numbers is a times sign.
        if ((src.charAt(i) === 'x' || src.charAt(i) === 'X') && isDigit(src.charAt(i + 1)) && !/[A-Za-z_]/.test(src.slice(i + 1).replace(/^\d+(\.\d+)?/, '').charAt(0))) {
          push('op', '*', undefined, i); i++;
        }
        continue;
      }
      // degree sign: °C / °F / °R or a bare ° (angle)
      if (c === '\u00b0' || c === '\u00ba') {
        var nx = src.charAt(i + 1);
        if (/[CcFfRr]/.test(nx) && !isIdChar(src.charAt(i + 2))) { push('id', '\u00b0' + nx.toUpperCase(), undefined, start); i += 2; }
        else { push('id', 'deg', undefined, start); i++; }
        continue;
      }
      if (c === '\u2103') { push('id', '\u00b0C', undefined, start); i++; continue; }
      if (c === '\u2109') { push('id', '\u00b0F', undefined, start); i++; continue; }
      if (c === '\u03c0') { push('id', 'pi', undefined, start); i++; continue; }
      if (c === '\u03c4') { push('id', 'tau', undefined, start); i++; continue; }
      if (c === '\u03c6' || c === '\u03d5') { push('id', 'phi', undefined, start); i++; continue; }
      if (c === '\u221a') { push('id', 'sqrt', undefined, start).bare = true; i++; continue; }
      if (c === '\u221b') { push('id', 'cbrt', undefined, start).bare = true; i++; continue; }
      if (isIdStart(c)) {
        var k = readIdent(i);
        var name = src.slice(i, k);
        // "L/100km" is one unit, not litres divided by 100 km.
        if (/^(l|L|liters?|litres?)$/.test(name)) {
          var lm = /^\s*\/\s*100\s*km\b/.exec(src.slice(k));
          if (lm) { push('id', 'L/100km', undefined, start); i = k + lm[0].length; continue; }
        }
        // Multi-word units: "fl oz", "sq ft", "uk fl oz", "light year".
        var rest = src.slice(k), best = null, bestLen = 0;
        var w2 = /^[ \t]+([A-Za-z]+)/.exec(rest);
        if (w2) {
          var two = (name + ' ' + w2[1]).toLowerCase();
          if (MW[two]) { best = two; bestLen = w2[0].length; }
          var w3 = /^[ \t]+([A-Za-z]+)/.exec(rest.slice(w2[0].length));
          if (w3 && MW[two + ' ' + w3[1].toLowerCase()]) { best = two + ' ' + w3[1].toLowerCase(); bestLen = w2[0].length + w3[0].length; }
        }
        if (best) { push('id', best, undefined, start); i = k + bestLen; continue; }
        // "3 x 4" — a lone x between two numbers is a times sign.
        if ((name === 'x' || name === 'X') && toks.length && toks[toks.length - 1].k === 'num' && /^\s*[\d.]/.test(rest)) {
          push('op', '*', undefined, start); i = k; continue;
        }
        if (name === 'per') { push('op', '/', undefined, start); i = k; continue; }
        push('id', name, undefined, start);
        i = k; continue;
      }
      // superscript powers: m², s⁻¹
      if (c === '\u207b' || SUP[c] !== undefined) {
        var neg = false, digits = '';
        if (c === '\u207b') { neg = true; i++; }
        while (i < n && SUP[src.charAt(i)] !== undefined) { digits += SUP[src.charAt(i)]; i++; }
        if (!digits) fail('Unexpected "\u207b"');
        push('op', '^', undefined, start);
        if (neg) push('op', '-', undefined, start);
        push('num', digits, +digits, start);
        continue;
      }
      if (c === '-' && src.charAt(i + 1) === '>') { push('id', 'to', undefined, start); i += 2; continue; }
      if (c === '\u2192') { push('id', 'to', undefined, start); i++; continue; }
      if (c === '*' && src.charAt(i + 1) === '*') { push('op', '^', undefined, start); i += 2; continue; }
      var op = OPMAP[c];
      if (op) {
        if (op === '(') {
          var prev = toks[toks.length - 1];
          paren.push(prev && prev.k === 'id' && FN[prev.s] ? 'call' : 'group');
        } else if (op === ')') paren.pop();
        push('op', op, undefined, start); i++; continue;
      }
      fail('Unexpected "' + c + '"');
    }
    return toks;
  }

  // ---- parser (tokens → AST) ---------------------------------------------------
  function Parser(toks, scope) { this.t = toks; this.i = 0; this.scope = scope; this.ops = 0; this.first = null; this.vars = []; }
  var PP = Parser.prototype;
  PP.peek = function (o) { return this.t[this.i + (o || 0)]; };
  PP.isOp = function (s, o) { var t = this.peek(o); return !!t && t.k === 'op' && t.s === s; };
  PP.isId = function (s, o) { var t = this.peek(o); return !!t && t.k === 'id' && t.s === s; };
  PP.expect = function (s) { if (!this.isOp(s)) fail(this.peek() ? 'Unexpected "' + this.peek().s + '"' : 'Missing "' + s + '"'); this.i++; };
  PP.isVar = function (name) { return name === 'ans' ? !!(this.scope && this.scope.ans) : !!(this.scope && this.scope.vars && Object.prototype.hasOwnProperty.call(this.scope.vars, name)); };
  // Does the token at offset o start an operand (for implicit multiplication)?
  PP.startsOperand = function (o) {
    var t = this.peek(o);
    if (!t) return false;
    if (t.k === 'num') return true;
    if (t.k === 'id') return !KEYWORDS[t.s];
    return t.k === 'op' && t.s === '(';
  };
  PP.unitAt = function (o) {
    var t = this.peek(o);
    if (!t || t.k !== 'id' || KEYWORDS[t.s] || this.isVar(t.s) || CONSTS[t.s] !== undefined) return null;
    if (FN[t.s] && this.isOp('(', (o || 0) + 1)) return null;
    return findUnit(t.s);
  };
  PP.mark = function (kind) { if (!this.first) this.first = kind; };

  PP.parseExpr = function () { return this.parseAdd(); };
  PP.parseAdd = function () {
    var a = this.parseMul();
    while (this.isOp('+') || this.isOp('-')) {
      var op = this.peek().s; this.i++;
      var b = this.parseMul();
      a = { t: 'b', op: op, a: a, b: b }; this.ops++;
    }
    return a;
  };
  PP.parseMul = function () {
    var a = this.parseUnary();
    for (;;) {
      var t = this.peek();
      if (!t) break;
      var op = null;
      if (t.k === 'op' && (t.s === '*' || t.s === '/')) op = t.s;
      else if (t.k === 'op' && t.s === '%') op = 'mod'; // postfix % already took the percent cases
      else if (t.k === 'id' && (t.s === 'mod' || t.s === 'of' || t.s === 'off')) op = t.s;
      if (op) { this.i++; a = { t: 'b', op: op, a: a, b: this.parseUnary() }; this.ops++; continue; }
      // implicit multiplication: 2pi, 3(4+5), (1+2)(3+4) — never "2 3"
      if (this.startsOperand() && t.k !== 'num') {
        a = { t: 'b', op: '*', a: a, b: this.parsePow() }; this.ops++; continue;
      }
      break;
    }
    return a;
  };
  PP.parseUnary = function () {
    if (this.isOp('-')) { this.i++; this.mark('op'); return { t: 'neg', a: this.parseUnary() }; }
    if (this.isOp('+')) { this.i++; return this.parseUnary(); }
    return this.parsePow();
  };
  PP.parsePow = function () {
    var a = this.parsePostfix();
    if (this.isOp('^')) { this.i++; this.ops++; return { t: 'b', op: '^', a: a, b: this.parseUnary() }; }
    return a;
  };
  PP.parsePostfix = function () {
    var a = this.parsePrimary();
    for (;;) {
      if (this.isOp('!')) { this.i++; this.ops++; a = { t: 'fact', a: a }; continue; }
      // % is "percent" unless an operand follows (then it's modulo: 10 % 3)
      if (this.isOp('%') && !this.startsOperand(1)) { this.i++; this.ops++; a = { t: 'pct', a: a }; continue; }
      break;
    }
    return a;
  };
  PP.parseUnitPow = function () {
    // optional ^n / ²  right after a unit name
    if (this.isOp('^') && (this.peek(1) && (this.peek(1).k === 'num' || (this.isOp('-', 1) && this.peek(2) && this.peek(2).k === 'num')))) {
      this.i++;
      var neg = false;
      if (this.isOp('-')) { neg = true; this.i++; }
      var v = this.peek().v; this.i++;
      if (v > 12) fail('Unit power too large');
      return neg ? -v : v;
    }
    return 1;
  };
  PP.parseQty = function () {
    // number [unit [^n]]* — units bind tightly to their number, so 10 m / 2 s works
    var t = this.peek(); this.i++;
    var units = [];
    while (this.unitAt()) {
      var u = this.unitAt(); this.i++;
      units.push([u, this.parseUnitPow()]);
    }
    return units.length ? { t: 'q', v: t.v, u: units } : { t: 'n', v: t.v };
  };
  PP.parsePrimary = function () {
    var t = this.peek();
    if (!t) fail('Incomplete expression');
    if (t.k === 'num') {
      this.mark('num');
      var q = this.parseQty();
      // mixed units: 5 ft 3 in, 1 h 30 min, 2 lb 4 oz
      if (q.t === 'q' && q.u.length === 1 && q.u[0][1] === 1 && !q.u[0][0].affine) {
        var parts = [q];
        while (this.peek() && this.peek().k === 'num') {
          var u2 = this.unitAt(1);
          if (!u2 || u2.dk !== q.u[0][0].dk || u2 === parts[parts.length - 1].u[0][0]) break;
          parts.push(this.parseQty());
        }
        if (parts.length > 1) { this.ops++; return { t: 'mix', parts: parts }; }
      }
      return q;
    }
    if (t.k === 'op' && t.s === '(') {
      this.mark('paren');
      this.i++;
      var e = this.parseExpr();
      this.expect(')');
      return e;
    }
    if (t.k === 'id') {
      var name = t.s;
      if (FN[name] && this.isOp('(', 1)) {
        this.mark('func');
        this.i += 2;
        var args = [];
        if (!this.isOp(')')) {
          args.push(this.parseExpr());
          while (this.isOp(',')) { this.i++; args.push(this.parseExpr()); }
        }
        this.expect(')');
        this.ops++;
        return { t: 'call', f: name, args: args };
      }
      if (KEYWORDS[name]) fail('Unexpected "' + name + '"');
      if (this.isVar(name)) { this.mark('var'); this.i++; this.vars.push(name); return { t: 'var', name: name }; }
      if (CONSTS[name] !== undefined) { this.mark('const'); this.i++; return { t: 'c', name: name }; }
      // sqrt 16, √16, sin 30 deg — one-argument functions without parentheses
      if (FN[name] && FN[name].n[0] === 1 && (t.bare || this.startsOperand(1))) {
        this.mark('func');
        this.i++; this.ops++;
        return { t: 'call', f: name, args: [this.parsePow()] };
      }
      var u = findUnit(name);
      if (u) { this.mark('unit'); this.i++; return { t: 'q', v: 1, u: [[u, this.parseUnitPow()]], bare: true }; }
      if (name === 'ans') fail('No previous answer yet');
      if (FN[name]) fail(name + '() needs parentheses');
      fail('Unknown name "' + name + '"');
    }
    fail('Unexpected "' + t.s + '"');
  };

  // Conversion target: a unit expression (km/h, m/s^2, L/100km, kg·m/s²) or a
  // number format (hex, bin, oct, dec, sci) or % / "% of <expr>".
  PP.parseTarget = function () {
    var t = this.peek();
    if (!t) fail('Missing target unit');
    if (t.k === 'id' && this.t.length === 1) {
      var f = t.s.toLowerCase();
      if (f === 'hex' || f === 'bin' || f === 'oct' || f === 'dec' || f === 'sci' || f === 'binary' || f === 'decimal' || f === 'octal' || f === 'scientific' || f === 'hexadecimal') {
        this.i++; return { kind: 'fmt', fmt: f.slice(0, 3) };
      }
    }
    if (t.k === 'id' && t.s === 'a' && this.isOp('%', 1)) { this.i++; t = this.peek(); }
    if (t.k === 'op' && t.s === '%') {
      this.i++;
      if (!this.peek()) return { kind: 'pct' };
      if (this.isId('of')) { this.i++; return { kind: 'pctof', e: this.parseExpr() }; }
      fail('Unexpected "' + this.peek().s + '"');
    }
    var h = this.parseUnitTerm(), sep;
    while (this.peek()) {
      if (this.isOp('*')) { this.i++; sep = 1; }
      else if (this.isOp('/')) { this.i++; sep = -1; }
      else if (this.peek().k === 'id' || this.isOp('(')) sep = 1;
      else fail('Unexpected "' + this.peek().s + '" in unit');
      h = mergeHints(h, this.parseUnitTerm(), sep, true);
    }
    if (!h) fail('Missing target unit');
    return { kind: 'unit', h: h };
  };
  PP.parseUnitTerm = function () {
    if (this.isOp('(')) {
      this.i++;
      var h = this.parseUnitTerm();
      while (!this.isOp(')')) {
        if (!this.peek()) fail('Missing ")"');
        var s = 1;
        if (this.isOp('*')) this.i++;
        else if (this.isOp('/')) { this.i++; s = -1; }
        h = mergeHints(h, this.parseUnitTerm(), s, true);
      }
      this.i++;
      var p0 = this.parseUnitPow();
      return h ? h.map(function (x) { return [x[0], x[1] * p0]; }) : h;
    }
    var t = this.peek();
    if (!t || t.k !== 'id') fail(t ? 'Unexpected "' + t.s + '" in unit' : 'Missing target unit');
    var u = findUnit(t.s);
    if (!u) fail('Unknown unit "' + t.s + '"');
    this.i++;
    return [[u, this.parseUnitPow()]];
  };

  // ---- quantities ---------------------------------------------------------------
  function Q(v, d, h) { return { v: v, d: d || ZERO, h: h || null, pct: false, abs: false }; }
  function isPlain(q) { return isZero(q.d) && !q.h && !q.pct; }
  function hintFactor(h) { var f = 1; if (h) for (var i = 0; i < h.length; i++) f *= Math.pow(h[i][0].f, h[i][1]); return f; }
  function singleTemp(h) { return h && h.length === 1 && h[0][1] === 1 && h[0][0].affine ? h[0][0] : null; }
  // value shown in the hint's units (absolute temperatures honour the offset)
  function dispValue(q) {
    var tu = q.abs ? singleTemp(q.h) : null;
    if (tu) return (q.v - tu.off) / tu.f;
    return q.v / hintFactor(q.h);
  }
  // build a quantity whose display value in hint h is x (keeping abs-temp semantics)
  function fromDisp(h, x, abs, d) {
    var q = Q(0, d, h);
    var tu = abs ? singleTemp(h) : null;
    if (tu) { q.v = x * tu.f + tu.off; q.abs = true; }
    else q.v = x * hintFactor(h);
    return q;
  }
  // an absolute temperature as a difference from its own unit's zero (20 °C → 20 K)
  function asDelta(q) {
    if (!q.abs) return q.v;
    var tu = singleTemp(q.h);
    return q.v - (tu ? tu.off : 0);
  }
  function mergeHints(h1, h2, s, keepUnits) {
    if (!h1 && !h2) return null;
    var out = h1 ? h1.map(function (x) { return [x[0], x[1]]; }) : [];
    if (h2) h2.forEach(function (x) {
      for (var j = 0; j < out.length; j++) {
        // same unit, or (for results) same dimension: show it in the left unit
        if (out[j][0] === x[0] || (!keepUnits && out[j][0].dk === x[0].dk && !isZero(x[0].d))) { out[j][1] += s * x[1]; return; }
      }
      out.push([x[0], s * x[1]]);
    });
    out = out.filter(function (x) { return Math.abs(x[1]) > 1e-12; });
    return out.length ? out : null;
  }
  function qtyLiteral(x, units) {
    var h = units.map(function (p) { return [p[0], p[1]]; });
    var d = ZERO;
    h.forEach(function (p) { d = dimsAdd(d, p[0].d, p[1]); });
    return fromDisp(h, x, !!singleTemp(h), d);
  }

  function add(a, b, sign) {
    var r;
    if (b.pct && !a.pct) {
      // 200 + 10% = 220; 50 km - 20% = 40 km
      var k = 1 + sign * b.v;
      if (a.abs) return fromDisp(a.h, dispValue(a) * k, true, a.d);
      r = Q(a.v * k, a.d, a.h); return r;
    }
    if (a.pct && isPlain(b)) { r = Q(a.v + sign * b.v / 100, ZERO, null); r.pct = true; return r; }
    // a bare number next to a quantity takes the quantity's unit: 5 km + 3
    if (isPlain(b) && !isPlain(a)) b = fromDisp(a.h, b.v, false, a.d);
    else if (isPlain(a) && !isPlain(b)) a = fromDisp(b.h, a.v, false, b.d);
    if (!dimsEq(a.d, b.d)) fail('Can\'t ' + (sign > 0 ? 'add ' : 'subtract ') + dimsName(b.d) + (sign > 0 ? ' to ' : ' from ') + dimsName(a.d));
    var h = a.h || b.h;
    if (a.abs && b.abs) {
      if (sign > 0) { r = Q(a.v + asDelta(b), a.d, h); r.abs = true; }
      else r = Q(a.v - b.v, a.d, h); // difference of two temperatures is a delta
    } else if (a.abs) { r = Q(a.v + sign * b.v, a.d, h); r.abs = true; }
    else if (b.abs && sign > 0) { r = Q(a.v + b.v, a.d, b.h); r.abs = true; }
    else r = Q(a.v + sign * b.v, a.d, h);
    r.pct = a.pct && b.pct;
    return r;
  }
  function mul(a, b, div) {
    if (div && b.v === 0) fail('Division by zero');
    // scaling an absolute temperature works on its own scale: 10 °C × 2 = 20 °C
    if (a.abs && isPlain(b)) return fromDisp(a.h, div ? dispValue(a) / b.v : dispValue(a) * b.v, true, a.d);
    if (b.abs && isPlain(a) && !div) return fromDisp(b.h, dispValue(b) * a.v, true, b.d);
    var r = Q(div ? a.v / b.v : a.v * b.v, dimsAdd(a.d, b.d, div ? -1 : 1), mergeHints(a.h, b.h, div ? -1 : 1));
    r.pct = a.pct && (isPlain(b) || (b.pct && !div));
    return r;
  }
  function power(a, b) {
    if (!isZero(b.d)) fail('Exponent must be a plain number');
    var e = b.v;
    if (isZero(a.d)) {
      var v = Math.pow(a.v, e);
      if (isNaN(v) && a.v < 0) {
        // real odd roots of negatives: (-8)^(1/3) = -2
        var inv = 1 / e, ri = Math.round(inv);
        if (Math.abs(inv - ri) < 1e-9 && ri % 2) v = -Math.pow(-a.v, e);
        else fail('No real result');
      }
      var hq = a.h ? a.h.map(function (x) { return [x[0], x[1] * e]; }) : null;
      return Q(v, ZERO, hq && hq.every(function (x) { return Math.abs(x[1] - Math.round(x[1])) < 1e-9; }) ? hq : null);
    }
    if (Math.abs(e) > 12) fail('Unit power too large');
    var d = dimsScale(a.d, e);
    for (var i = 0; i < 6; i++) { if (Math.abs(d[i] - Math.round(d[i])) > 1e-9) fail('Fractional power of a unit'); d[i] = Math.round(d[i]); }
    var h = a.h ? a.h.map(function (x) { return [x[0], x[1] * e]; }) : null;
    if (h && !h.every(function (x) { return Math.abs(x[1] - Math.round(x[1])) < 1e-9; })) h = null;
    return Q(Math.pow(a.v, e), d, h);
  }
  function neg(a) {
    if (a.abs) return fromDisp(a.h, -dispValue(a), true, a.d);
    var r = Q(-a.v, a.d, a.h); r.pct = a.pct; return r;
  }
  function gamma(x) {
    if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gamma(1 - x));
    var g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
      12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    x -= 1;
    var a = c[0], t = x + g + 0.5;
    for (var i = 1; i < g + 2; i++) a += c[i] / (x + i);
    return Math.sqrt(2 * Math.PI) * Math.pow(t, x + 0.5) * Math.exp(-t) * a;
  }
  function factorial(n) {
    if (n < 0 && n === Math.floor(n)) fail('Factorial of a negative integer');
    if (n > 170) fail('Result too large');
    if (n === Math.floor(n)) { var r = 1; for (var i = 2; i <= n; i++) r *= i; return r; }
    return gamma(n + 1);
  }

  // ---- functions --------------------------------------------------------------
  function plainArg(q, fname) {
    if (!isZero(q.d)) fail(fname + '() needs a plain number, not ' + dimsName(q.d));
    return q.v;
  }
  function num1(fn) { return function (a, name) { return Q(fn(plainArg(a[0], name))); }; }
  function sameDims(args, name) {
    for (var i = 1; i < args.length; i++) if (!dimsEq(args[i].d, args[0].d)) fail(name + '() arguments must share a unit type');
  }
  // rounding works on the shown value so round(2.567 km, 1) = 2.6 km
  function roundish(fn) {
    return function (a, name) {
      var q = a[0], nd = a[1] ? plainArg(a[1], name) : 0;
      var x = dispValue(q), m = Math.pow(10, Math.round(nd));
      var y = fn(x * m) / m;
      if (q.pct) { var p = fn(q.v * 100 * m) / m / 100; var rp = Q(p); rp.pct = true; return rp; }
      return fromDisp(q.h, y, q.abs, q.d);
    };
  }
  function listFn(fn) {
    return function (args, name) {
      if (!args.length) fail(name + '() needs arguments');
      sameDims(args, name);
      var vals = args.map(function (q) { return q.v; });
      var r = Q(fn(vals), args[0].d, args[0].h);
      r.abs = args[0].abs && name !== 'sum';
      r.pct = args.every(function (q) { return q.pct; });
      return r;
    };
  }
  function gcd2(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { var t = b; b = a % b; a = t; } return a; }
  function intArg(q, name) { var v = plainArg(q, name); if (v !== Math.round(v)) fail(name + '() needs whole numbers'); return v; }
  function rootFn(k) {
    return function (a) {
      var q = a[0];
      if (isZero(q.d) && q.v < 0 && k % 2 === 0) fail('No real result');
      if (isZero(q.d) && !q.h) return Q(k === 3 ? Math.cbrt(q.v) : Math.sqrt(q.v));
      return power(q, Q(1 / k));
    };
  }
  var FN = {
    sqrt: { n: [1, 1], f: rootFn(2) },
    cbrt: { n: [1, 1], f: rootFn(3) },
    root: { n: [2, 2], f: function (a, nm) { var k = plainArg(a[1], nm); return k === 3 ? rootFn(3)([a[0]]) : (k === 2 ? rootFn(2)([a[0]]) : power(a[0], Q(1 / k))); } },
    abs: { n: [1, 1], f: function (a) { var q = a[0]; return q.abs ? fromDisp(q.h, Math.abs(dispValue(q)), true, q.d) : (function () { var r = Q(Math.abs(q.v), q.d, q.h); r.pct = q.pct; return r; })(); } },
    round: { n: [1, 2], f: roundish(Math.round) },
    floor: { n: [1, 2], f: roundish(Math.floor) },
    ceil: { n: [1, 2], f: roundish(Math.ceil) },
    trunc: { n: [1, 2], f: roundish(function (x) { return x < 0 ? Math.ceil(x) : Math.floor(x); }) },
    sign: { n: [1, 1], f: function (a) { return Q(Math.sign ? Math.sign(a[0].v) : (a[0].v > 0 ? 1 : a[0].v < 0 ? -1 : 0)); } },
    min: { n: [1, 99], f: listFn(function (v) { return Math.min.apply(null, v); }) },
    max: { n: [1, 99], f: listFn(function (v) { return Math.max.apply(null, v); }) },
    sum: { n: [1, 99], f: listFn(function (v) { return v.reduce(function (s, x) { return s + x; }, 0); }) },
    avg: { n: [1, 99], f: listFn(function (v) { return v.reduce(function (s, x) { return s + x; }, 0) / v.length; }) },
    mean: { n: [1, 99], f: listFn(function (v) { return v.reduce(function (s, x) { return s + x; }, 0) / v.length; }) },
    median: { n: [1, 99], f: listFn(function (v) { var s = v.slice().sort(function (x, y) { return x - y; }), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }) },
    hypot: { n: [1, 99], f: function (a, nm) { sameDims(a, nm); return Q(Math.sqrt(a.reduce(function (s, q) { return s + q.v * q.v; }, 0)), a[0].d, a[0].h); } },
    log: { n: [1, 2], f: function (a, nm) { var x = plainArg(a[0], nm); if (a[1]) return Q(Math.log(x) / Math.log(plainArg(a[1], nm))); return Q(Math.log(x) / Math.LN10); } },
    log10: { n: [1, 1], f: num1(function (x) { return Math.log(x) / Math.LN10; }) },
    log2: { n: [1, 1], f: num1(function (x) { return Math.log(x) / Math.LN2; }) },
    ln: { n: [1, 1], f: num1(Math.log) },
    exp: { n: [1, 1], f: num1(Math.exp) },
    pow: { n: [2, 2], f: function (a) { return power(a[0], a[1]); } },
    sin: { n: [1, 1], f: num1(Math.sin) },
    cos: { n: [1, 1], f: num1(Math.cos) },
    tan: { n: [1, 1], f: num1(Math.tan) },
    asin: { n: [1, 1], f: num1(Math.asin) },
    acos: { n: [1, 1], f: num1(Math.acos) },
    atan: { n: [1, 1], f: num1(Math.atan) },
    atan2: { n: [2, 2], f: function (a, nm) { sameDims(a, nm); return Q(Math.atan2(a[0].v, a[1].v)); } },
    sinh: { n: [1, 1], f: num1(function (x) { return (Math.exp(x) - Math.exp(-x)) / 2; }) },
    cosh: { n: [1, 1], f: num1(function (x) { return (Math.exp(x) + Math.exp(-x)) / 2; }) },
    tanh: { n: [1, 1], f: num1(function (x) { var a = Math.exp(x), b = Math.exp(-x); return (a - b) / (a + b); }) },
    fact: { n: [1, 1], f: num1(factorial) },
    factorial: { n: [1, 1], f: num1(factorial) },
    gamma: { n: [1, 1], f: num1(gamma) },
    gcd: { n: [1, 99], f: function (a, nm) { return Q(a.map(function (q) { return intArg(q, nm); }).reduce(gcd2)); } },
    lcm: { n: [1, 99], f: function (a, nm) { return Q(a.map(function (q) { return intArg(q, nm); }).reduce(function (x, y) { return x && y ? Math.abs(x * y) / gcd2(x, y) : 0; })); } },
    ncr: { n: [2, 2], f: function (a, nm) { var n = intArg(a[0], nm), k = intArg(a[1], nm); if (k < 0 || k > n) return Q(0); var r = 1; k = Math.min(k, n - k); for (var i = 1; i <= k; i++) r = r * (n - k + i) / i; return Q(Math.round(r)); } },
    npr: { n: [2, 2], f: function (a, nm) { var n = intArg(a[0], nm), k = intArg(a[1], nm); if (k < 0 || k > n) return Q(0); var r = 1; for (var i = 0; i < k; i++) r *= n - i; return Q(r); } },
    mod: { n: [2, 2], f: function (a) { return modulo(a[0], a[1]); } }
  };
  FN.choose = FN.ncr;
  function modulo(a, b) {
    if (!dimsEq(a.d, b.d) && !isPlain(b)) fail('mod needs matching units');
    var bv = isPlain(b) && !isPlain(a) ? b.v * hintFactor(a.h) : b.v;
    if (bv === 0) fail('Division by zero');
    var r = a.v - bv * Math.floor(a.v / bv);
    if (Math.abs(r - bv) < Math.abs(bv) * 1e-12) r = 0;
    return Q(r, a.d, a.h);
  }

  // ---- evaluation -------------------------------------------------------------
  function evalNode(n, scope) {
    switch (n.t) {
      case 'n': return Q(n.v);
      case 'q': return qtyLiteral(n.v, n.u);
      case 'mix':
        var acc = evalNode(n.parts[0], scope);
        for (var i = 1; i < n.parts.length; i++) acc = add(acc, evalNode(n.parts[i], scope), 1);
        return acc;
      case 'c': return Q(CONSTS[n.name]);
      case 'var':
        var v = n.name === 'ans' ? scope.ans : scope.vars[n.name];
        var c = Q(v.v, v.d, v.h); c.pct = v.pct; c.abs = v.abs; return c;
      case 'neg': return neg(evalNode(n.a, scope));
      case 'fact':
        var fa = evalNode(n.a, scope);
        return Q(factorial(plainArg(fa, 'factorial')));
      case 'pct':
        var pa = evalNode(n.a, scope);
        if (!isPlain(pa)) fail('% needs a plain number');
        var pq = Q(pa.v / 100); pq.pct = true; return pq;
      case 'call':
        var spec = FN[n.f];
        if (n.args.length < spec.n[0] || n.args.length > spec.n[1]) fail(n.f + '() takes ' + (spec.n[0] === spec.n[1] ? spec.n[0] : spec.n[0] + '+') + ' argument' + (spec.n[1] > 1 ? 's' : ''));
        return spec.f(n.args.map(function (x) { return evalNode(x, scope); }), n.f);
      case 'b':
        var a = evalNode(n.a, scope), b = evalNode(n.b, scope);
        switch (n.op) {
          case '+': return add(a, b, 1);
          case '-': return add(a, b, -1);
          case '*': return mul(a, b, false);
          case '/': return mul(a, b, true);
          case '^': return power(a, b);
          case 'mod': return modulo(a, b);
          case 'of':
            // 10% of 200 = 20; 1/2 of 300 = 150
            if (!isZero(a.d)) fail('"of" needs a percentage or number on the left');
            return mul(Q(a.v), b, false);
          case 'off':
            if (!isZero(a.d)) fail('"off" needs a percentage on the left');
            return mul(b, Q(1 - a.v), false);
        }
    }
    fail('Bad expression');
  }

  // collapse compound hints that equal a named unit: kg·m/s² → N, W·h → Wh, mi/gal → mpg
  var BASE_DIMS = { '1,0,0,0,0,0': 1, '0,1,0,0,0,0': 1, '0,0,1,0,0,0': 1, '0,0,0,1,0,0': 1, '0,0,0,0,0,1': 1 };
  function tidyHint(q) {
    if (!q.h) { if (!isZero(q.d)) q.h = siHint(q.d); return q; }
    if (q.h.length < 2 || q.conv) return q;
    var dk = dkey(q.d), f = hintFactor(q.h), cands = BYDIMS[dk];
    if (cands) for (var i = 0; i < cands.length; i++) {
      if (!cands[i].affine && Math.abs(cands[i].f - f) <= Math.abs(f) * 1e-9) { q.h = [[cands[i], 1]]; return q; }
    }
    // units that cancel down to a plain base dimension read best in SI: GiB / Mbps → s
    if (BASE_DIMS[dk] && cands) q.h = [[cands.filter(function (u) { return u.f === 1; })[0] || cands[0], 1]];
    return q;
  }

  // ---- formatting -------------------------------------------------------------
  var SUPS = ['\u2070', '\u00b9', '\u00b2', '\u00b3', '\u2074', '\u2075', '\u2076', '\u2077', '\u2078', '\u2079'];
  function supNum(p) {
    var s = String(Math.abs(p)), out = p < 0 ? '\u207b' : '';
    if (!/^\d+$/.test(s)) return '^' + p;
    for (var i = 0; i < s.length; i++) out += SUPS[+s.charAt(i)];
    return out;
  }
  function unitPow(u, p, x) {
    var sym = u.sym;
    if (p === 1 && u.plural && x != null && Math.abs(x) !== 1) sym = u.plural;
    if (p === 1) return sym;
    if (/[\u00b2\u00b3\s\/\u00b7]/.test(sym)) return '(' + sym + ')' + supNum(p);
    return sym + supNum(p);
  }
  function renderHint(h, x) {
    if (!h || !h.length) return '';
    if (h.length === 1) return unitPow(h[0][0], h[0][1], x);
    var num = [], den = [];
    h.forEach(function (p) { if (p[1] > 0) num.push(unitPow(p[0], p[1])); else den.push(unitPow(p[0], -p[1])); });
    if (!num.length) return h.map(function (p) { return unitPow(p[0], p[1]); }).join('\u00b7');
    var s = num.join('\u00b7');
    if (den.length) s += '/' + (den.length > 1 ? '(' + den.join('\u00b7') + ')' : den[0]);
    return s;
  }
  function groupInt(s, sep) { return s.replace(/\B(?=(\d{3})+(?!\d))/g, sep); }
  function formatNumber(x, opts) {
    opts = opts || {};
    var prec = opts.precision || 10;
    if (typeof x !== 'number' || isNaN(x)) return 'NaN';
    if (!isFinite(x)) return x > 0 ? '\u221e' : '-\u221e';
    if (x === 0) return '0';
    var ax = Math.abs(x), s;
    if (ax >= 1e15 || ax < 1e-9) {
      s = x.toExponential(prec - 1).replace(/\.?0+e/, 'e').replace('e+', 'e');
      return s;
    }
    // Whole-number digits are never rounded away (2^40 stays exact); the
    // precision only limits decimals, which also hides float noise (0.1+0.2).
    if (Math.floor(Math.log(ax) / Math.LN10) + 1 >= prec) s = Math.round(x).toFixed(0);
    else {
      var r = parseFloat(x.toPrecision(prec));
      if (r === 0) return '0';
      var mag = Math.floor(Math.log(Math.abs(r)) / Math.LN10);
      s = r.toFixed(Math.max(0, Math.min(20, prec - 1 - mag)));
    }
    if (s.indexOf('.') !== -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
    if (s === '-0') s = '0';
    if (opts.thousands) {
      var neg = s.charAt(0) === '-', body = neg ? s.slice(1) : s;
      var parts = body.split('.');
      parts[0] = groupInt(parts[0], ',');
      s = (neg ? '-' : '') + parts.join('.');
    }
    return s;
  }
  function formatQty(q, opts) {
    if (q.fmtText) return q.fmtText;
    if (q.pct) return formatNumber(q.v * 100, opts) + '%';
    var x = dispValue(q);
    var n = formatNumber(x, opts);
    var u = renderHint(q.h, parseFloat(formatNumber(x, { precision: (opts && opts.precision) || 10 })));
    if (!u) return n;
    return n + (u === '\u00b0' ? '' : ' ') + u;
  }

  function intText(q, base) {
    if (!isPlain(q) && !(isZero(q.d))) fail('Only plain numbers convert to ' + base);
    var v = q.v;
    if (Math.abs(v - Math.round(v)) > 1e-9) fail('Only whole numbers convert to ' + base);
    v = Math.round(v);
    if (Math.abs(v) > 9007199254740991) fail('Number too large');
    var pre = { hex: '0x', bin: '0b', oct: '0o' }[base], radix = { hex: 16, bin: 2, oct: 8 }[base];
    var s = Math.abs(v).toString(radix);
    return (v < 0 ? '-' : '') + pre + (base === 'hex' ? s.toUpperCase() : s);
  }

  function convertQ(q, target, scope) {
    if (target.kind === 'fmt') {
      var r = Q(q.v, q.d, q.h); r.pct = q.pct; r.abs = q.abs;
      if (target.fmt === 'hex' || target.fmt === 'bin' || target.fmt === 'oct') r.fmtText = intText(q, target.fmt);
      else if (target.fmt === 'sci') r.fmtText = (function () { var x = q.pct ? q.v * 100 : dispValue(q); var t = x.toExponential(9).replace(/\.?0+e/, 'e').replace('e+', 'e'); var u = q.pct ? '%' : renderHint(q.h, x); return t + (u ? (u === '%' || u === '\u00b0' ? '' : ' ') + u : ''); })();
      else { r.pct = false; if (isPlain(q) || q.pct) r.h = null; }
      return r;
    }
    if (target.kind === 'pct') {
      if (!isZero(q.d)) fail('Only plain numbers convert to %');
      var p = Q(q.v); p.pct = true; return p;
    }
    if (target.kind === 'pctof') {
      var b = evalNode(target.e, scope);
      if (!dimsEq(q.d, b.d)) fail('Can\'t compare ' + dimsName(q.d) + ' with ' + dimsName(b.d));
      if (b.v === 0) fail('Division by zero');
      var pp = Q(q.v / b.v); pp.pct = true; return pp;
    }
    var h = target.h, td = ZERO;
    h.forEach(function (x) { td = dimsAdd(td, x[0].d, x[1]); });
    var src = q;
    if (q.pct) { src = Q(q.v); }
    var out;
    if (dimsEq(src.d, td)) {
      out = Q(src.v, td, h);
      // temperatures: absolute stays absolute, differences stay differences
      out.abs = src.abs;
    } else if (dimsEq(src.d, dimsScale(td, -1)) && (isFuel(h) || isFuel(src.h)) && src.v !== 0) {
      out = Q(1 / src.v, td, h); // mpg ↔ L/100km is a reciprocal
    } else {
      // say what the target needs: "Can't convert mass to km - expected a length"
      var want = isZero(td) ? 'an angle or plain number' : aOrAn(dimsName(td));
      fail('Can\'t convert ' + dimsName(src.d) + ' to ' + renderHint(h) + ' \u2014 expected ' + want +
        (isZero(src.d) && !isZero(td) ? ' (e.g. 5 ' + exampleUnit(td, h) + ' to ' + renderHint(h) + ')' : ''));
    }
    out.conv = true;
    return out;
  }
  function exampleUnit(td, h) {
    var tgt = renderHint(h), us = (BYDIMS[dkey(td)] || []).filter(function (x) { return x.sym !== tgt && !x.affine; });
    var u = us.filter(function (x) { return x.f === 1; })[0] || us[0] || h[0][0];
    return u.sym;
  }
  function aOrAn(w) { return (/^[aeiou]/i.test(w) ? 'an ' : 'a ') + w; }
  function isFuel(h) { return !!h && h.some(function (x) { return x[0].cat === 'fuel'; }); }

  // ---- public evaluate --------------------------------------------------------
  function createScope() { return { vars: {}, ans: null }; }

  function splitConversion(toks) {
    var depth = 0, cands = [];
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (t.k === 'op' && t.s === '(') depth++;
      else if (t.k === 'op' && t.s === ')') depth--;
      else if (depth === 0 && t.k === 'id' && CONV_WORDS[t.s] && i > 0 && i < toks.length - 1) cands.push(i);
    }
    return cands;
  }

  function parseAll(toks, scope) {
    var info = { ops: 0, first: null, vars: [], assign: null, conv: false };
    var start = 0;
    // assignment: name = expr
    if (toks.length > 2 && toks[0].k === 'id' && toks[1].k === 'op' && toks[1].s === '=') {
      var nm = toks[0].s;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(nm) || FN[nm] || CONSTS[nm] !== undefined || KEYWORDS[nm] || CONV_WORDS[nm] || nm === 'ans') fail('Can\'t assign to "' + nm + '"');
      info.assign = nm;
      start = 2;
    }
    var body = toks.slice(start);
    if (!body.length) fail('Empty expression');
    for (var i = 0; i < body.length; i++) if (body[i].k === 'op' && body[i].s === '=') fail('Unexpected "="');
    var node = null, target = null, firstErr = null, P;
    var cands = splitConversion(body);
    for (var c = cands.length - 1; c >= 0 && !node; c--) {
      try {
        var tp = new Parser(body.slice(cands[c] + 1), scope);
        var tg = tp.parseTarget();
        if (tp.i < tp.t.length) continue;
        P = new Parser(body.slice(0, cands[c]), scope);
        var e = P.parseExpr();
        if (P.i < P.t.length) continue;
        node = e; target = tg; info.convWord = body[cands[c]].s;
      } catch (err) { if (!(err instanceof CalcError)) throw err; }
    }
    if (!node) {
      P = new Parser(body, scope);
      node = P.parseExpr();
      if (P.i < P.t.length) fail('Unexpected "' + P.peek().s + '"');
    } else info.conv = true;
    info.ops = P.ops + (target ? 1 : 0);
    info.first = P.first;
    info.vars = P.vars;
    return { node: node, target: target, info: info };
  }

  function evaluate(src, opts) {
    opts = opts || {};
    var scope = opts.scope || createScope();
    src = String(src == null ? '' : src).trim();
    // a trailing "=" (as typed in notes) is just the ask for the answer
    if (/[^=<>!:]=\s*$/.test(src)) src = src.replace(/=\s*$/, '').trim();
    if (!src) return { ok: false, error: 'Empty', empty: true };
    if (src.length > 1000) return { ok: false, error: 'Expression too long' };
    try {
      var toks = tokenize(src);
      var parsed = parseAll(toks, scope);
      var q = evalNode(parsed.node, scope);
      // "5 in cm": a plain number before "in <length>" means inches (the
      // "in" is the unit, with an implied "to")
      if (parsed.target && parsed.target.kind === 'unit' && parsed.info.convWord === 'in' && isPlain(q) &&
          dimsEq(parsed.target.h.reduce(function (d, x) { return dimsAdd(d, x[0].d, x[1]); }, ZERO), BYID['in'].d)) {
        q = qtyLiteral(q.v, [[BYID['in'], 1]]);
      }
      if (parsed.target) q = convertQ(q, parsed.target, scope);
      if (typeof q.v !== 'number' || isNaN(q.v)) fail('Not a number');
      if (!isFinite(q.v)) fail(q.v > 0 ? 'Result is infinite' : 'Result is -infinite');
      if (!isFinite(dispValue(q)) || (q.h && !hintFactor(q.h))) fail('Result out of range');
      tidyHint(q);
      var fo = { thousands: !!opts.thousands, precision: opts.precision || 10 };
      var text = formatQty(q, fo);
      var plain = opts.thousands ? formatQty(q, { precision: fo.precision }) : text;
      var stored = { v: q.v, d: q.d, h: q.h, pct: q.pct, abs: q.abs };
      if (parsed.info.assign) scope.vars[parsed.info.assign] = stored;
      if (opts.setAns !== false) scope.ans = stored;
      var unit = q.fmtText ? '' : (q.pct ? '%' : renderHint(q.h, dispValue(q)));
      return {
        ok: true, text: text, plain: plain, value: q.pct ? q.v * 100 : dispValue(q), unit: unit,
        si: q.v, dims: q.d.slice(), info: parsed.info, assigned: parsed.info.assign, q: stored
      };
    } catch (err) {
      if (err instanceof CalcError) return { ok: false, error: err.message };
      return { ok: false, error: 'Error: ' + (err && err.message || err) };
    }
  }

  // ---- converter API (Unit Converter widget) ------------------------------------
  var CATEGORIES = [
    { id: 'length', name: 'Length', icon: '\ud83d\udccf', units: 'mm cm m km in ft yd mi nmi um nm dm thou fathom furlong ang au ly pc' },
    { id: 'mass', name: 'Mass', icon: '\u2696\ufe0f', units: 'mg g kg t oz lb st ton lton ug gr ct' },
    { id: 'volume', name: 'Volume', icon: '\ud83e\uddea', units: 'ml cl dl l m3 cm3 in3 ft3 yd3 tsp tbsp floz cup pt qt gal ukfloz ukpt ukqt ukgal bbl mcup' },
    { id: 'cooking', name: 'Cooking', icon: '\ud83e\udd44', units: 'tsp tbsp floz cup mcup pt qt gal ml dl l ukfloz ukpt' },
    { id: 'temperature', name: 'Temperature', icon: '\ud83c\udf21\ufe0f', units: 'degC degF K degR' },
    { id: 'area', name: 'Area', icon: '\u2b1b', units: 'mm2 cm2 m2 ha km2 in2 ft2 yd2 acre mi2' },
    { id: 'speed', name: 'Speed', icon: '\ud83d\ude80', units: 'kmh mph mps fps kn mach' },
    { id: 'time', name: 'Time', icon: '\u23f1\ufe0f', units: 'ns us ms s min h day week fortnight month year decade century' },
    { id: 'data', name: 'Data', icon: '\ud83d\udcbe', units: 'bit B kB MB GB TB PB KiB MiB GiB TiB PiB kbit Mbit Gbit Tbit' },
    { id: 'datarate', name: 'Data rate', icon: '\ud83d\udce1', units: 'bps kbps Mbps Gbps Bps kBps MBps GBps' },
    { id: 'pressure', name: 'Pressure', icon: '\ud83c\udf88', units: 'Pa hPa kPa MPa bar mbar atm psi mmHg inHg torr' },
    { id: 'energy', name: 'Energy', icon: '\u26a1', units: 'J kJ MJ GJ cal kcal Wh kWh MWh BTU therm eV ftlbf erg' },
    { id: 'power', name: 'Power', icon: '\ud83d\udca1', units: 'W mW kW MW GW hp PS BTUh' },
    { id: 'force', name: 'Force', icon: '\ud83d\udcaa', units: 'N kN dyn lbf kgf' },
    { id: 'angle', name: 'Angle', icon: '\ud83d\udcd0', units: 'deg rad grad turn arcmin arcsec' },
    { id: 'frequency', name: 'Frequency', icon: '\u3030\ufe0f', units: 'Hz kHz MHz GHz THz rpm bpm' },
    { id: 'fuel', name: 'Fuel economy', icon: '\u26fd', units: 'mpg mpguk kmpl l100km' }
  ].map(function (c) { return { id: c.id, name: c.name, icon: c.icon, units: c.units.split(' ').map(function (id) { return BYID[id]; }).filter(Boolean) }; });

  // value in unit `from` → value in unit `to` (affine temperatures, reciprocal fuel units)
  function convertValue(x, from, to) {
    if (typeof from === 'string') from = BYID[from];
    if (typeof to === 'string') to = BYID[to];
    if (!from || !to || typeof x !== 'number' || !isFinite(x)) return NaN;
    var si = x * from.f + (from.affine ? from.off : 0);
    if (from.dk === to.dk) return (si - (to.affine ? to.off : 0)) / to.f;
    if (dimsEq(from.d, dimsScale(to.d, -1)) && (from.cat === 'fuel' || to.cat === 'fuel')) return si === 0 ? NaN : 1 / si / to.f;
    return NaN;
  }

  // "5 km", "3.5 lb", "100°F" → {value, unit} (single-unit quantity), else null
  function parseQuantity(src) {
    try {
      var toks = tokenize(String(src || '').trim());
      if (!toks.length) return null;
      var P = new Parser(toks, null), sign = 1;
      if (P.isOp('-')) { sign = -1; P.i++; }
      if (!P.peek() || P.peek().k !== 'num') return null;
      var n = P.parseQty();
      if (P.i < toks.length || n.t !== 'q' || n.u.length !== 1 || n.u[0][1] !== 1) return null;
      return { value: sign * n.v, unit: n.u[0][0] };
    } catch (e) { return null; }
  }

  root.__cadeCalcEngine = {
    version: 1,
    evaluate: evaluate,
    createScope: createScope,
    formatNumber: formatNumber,
    findUnit: findUnit,
    unitById: function (id) { return BYID[id] || null; },
    units: UNITS,
    categories: CATEGORIES,
    convertValue: convertValue,
    parseQuantity: parseQuantity,
    functions: Object.keys(FN),
    constants: Object.keys(CONSTS)
  };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
