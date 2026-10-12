#!/usr/bin/env python3
"""Builds symbols-data.js for the Symbols & Alt Codes widget.

Sources (downloaded into a cache folder on first run):
  - UnicodeData.txt            official character names
  - emoji-test.txt             emoji list with group / subgroup (CLDR order)
  - CLDR annotations (en)      semantic keywords for emoji AND many symbols
  - CLDR derived annotations   keywords for emoji sequences (flags, ZWJ, ...)

On top of those, this file adds: categories / sub-categories for browsing,
curated aliases ("tick", "degree", "pilcrow", ...), rule-based thematic tags
(direction, weather, logic, ...), Windows Alt codes (CP437 Alt+1..255 and
Windows-1252 Alt+0128..0255), Mac Option-key shortcuts, HTML entities and a
popularity rank used to order search results.

Usage:  python3 build-data.py [cache-dir]
Writes symbols-data.js next to this script.
"""
import html.entities
import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, '.cache')
MAX_EMOJI_VERSION = 16.0   # newer emoji render as tofu on many devices

SOURCES = {
    'UnicodeData.txt': 'https://www.unicode.org/Public/UCD/latest/ucd/UnicodeData.txt',
    'emoji-test.txt': 'https://www.unicode.org/Public/emoji/latest/emoji-test.txt',
    'ann.json': 'https://cdn.jsdelivr.net/npm/cldr-annotations-full@47.0.0/annotations/en/annotations.json',
    'annd.json': 'https://cdn.jsdelivr.net/npm/cldr-annotations-derived-full@47.0.0/annotationsDerived/en/annotations.json',
}


def src(name):
    os.makedirs(CACHE, exist_ok=True)
    p = os.path.join(CACHE, name)
    if not os.path.exists(p):
        urllib.request.urlretrieve(SOURCES[name], p)
    return p


# ---------------------------------------------------------------- sources
NAMES = {}
for line in open(src('UnicodeData.txt'), encoding='utf-8'):
    f = line.split(';')
    if f[1].startswith('<'):
        continue
    NAMES[int(f[0], 16)] = f[1]

ANN = json.load(open(src('ann.json'), encoding='utf-8'))['annotations']['annotations']
ANND = json.load(open(src('annd.json'), encoding='utf-8'))['annotationsDerived']['annotations']


def cldr(s):
    a = ANN.get(s) or ANN.get(s.replace('️', '')) or ANND.get(s) or ANND.get(s.replace('️', ''))
    if not a:
        return [], ''
    return a.get('default', []), (a.get('tts') or [''])[0]


# ---------------------------------------------------------------- alt codes
CP437_LOW = '☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼'
ALT = {}  # char -> ['130', '0233', ...]


def add_alt(ch, code):
    ALT.setdefault(ch, [])
    if code not in ALT[ch]:
        ALT[ch].append(code)


for i, ch in enumerate(CP437_LOW, 1):
    add_alt(ch, str(i))
add_alt('⌂', '127')
for i in range(128, 256):
    add_alt(bytes([i]).decode('cp437'), str(i))
for i in range(128, 256):
    try:
        add_alt(bytes([i]).decode('cp1252'), '%04d' % i)
    except UnicodeDecodeError:
        pass

# Mac (US layout) Option-key shortcuts for the usual suspects.
MAC = {
    '™': '⌥2', '©': '⌥G', '®': '⌥R', '•': '⌥8', '…': '⌥;', '–': '⌥-', '—': '⌥⇧-',
    '°': '⌥⇧8', '≠': '⌥=', '≤': '⌥,', '≥': '⌥.', '≈': '⌥X', '∞': '⌥5', '√': '⌥V',
    '∑': '⌥W', 'π': '⌥P', 'Ω': '⌥Z', '∂': '⌥D', '∆': '⌥J', '±': '⌥⇧=', '÷': '⌥/',
    '¶': '⌥7', '§': '⌥6', '†': '⌥T', '‡': '⌥⇧7', '¢': '⌥4', '£': '⌥3', '¥': '⌥Y',
    '€': '⌥⇧2', '“': '⌥[', '”': '⌥⇧[', '‘': '⌥]', '’': '⌥⇧]', '¡': '⌥1', '¿': '⌥⇧/',
    'ß': '⌥S', 'æ': '⌥\'', 'Æ': '⌥⇧\'', 'œ': '⌥Q', 'Œ': '⌥⇧Q', 'ø': '⌥O', 'Ø': '⌥⇧O',
    'å': '⌥A', 'Å': '⌥⇧A', 'ç': '⌥C', 'Ç': '⌥⇧C', 'ƒ': '⌥F', '∫': '⌥B', '¬': '⌥L',
    '«': '⌥\\', '»': '⌥⇧\\', 'ª': '⌥9', 'º': '⌥0', '·': '⌥⇧9', '◊': '⌥⇧V', '': '⌥⇧K',
    '‰': '⌥⇧R', '∏': '⌥⇧P', 'µ': '⌥M', '¯': '⌥⇧,', '˘': '⌥⇧.', '‹': '⌥⇧3', '›': '⌥⇧4',
    '⁄': '⌥⇧1', '‚': '⌥⇧0', '„': '⌥⇧W', 'Ω': '⌥Z',
}
MAC.pop('', None)

ENTITY = {}
for name, cp in html.entities.name2codepoint.items():
    ch = chr(cp)
    # prefer the shortest / most familiar name
    if ch not in ENTITY or len(name) < len(ENTITY[ch]):
        ENTITY[ch] = name
for ch, n in {'—': 'mdash', '–': 'ndash', '←': 'larr', '→': 'rarr', '“': 'ldquo', '”': 'rdquo',
              '’': 'rsquo', '‘': 'lsquo', '©': 'copy', '®': 'reg', '™': 'trade', ' ': 'nbsp',
              '…': 'hellip', '·': 'middot', '¢': 'cent', '½': 'frac12'}.items():
    ENTITY[ch] = n


# ---------------------------------------------------------------- curated
# Extra aliases / meta keywords people actually type. These rank just under
# the official name.
ALIASES = {
    '©': 'copyright c circle legal rights', '®': 'registered trademark r circle brand legal',
    '™': 'trademark tm brand legal', '℠': 'service mark sm', '°': 'degree degrees temperature angle deg',
    '•': 'bullet dot list point middle', '·': 'middle dot interpunct centered dot multiply',
    '…': 'ellipsis dots three dots etc trailing', '—': 'em dash long dash break', '–': 'en dash range between number range',
    '‑': 'non-breaking hyphen nbhy', '−': 'minus subtract negative math', '×': 'multiply times multiplication x product',
    '÷': 'divide division obelus', '±': 'plus minus plusminus tolerance error', '∓': 'minus plus',
    '≠': 'not equal unequal different', '≈': 'approximately almost equal about roughly approx',
    '≡': 'identical congruent equivalent defined as', '≤': 'less than or equal lte at most',
    '≥': 'greater than or equal gte at least', '≪': 'much less than', '≫': 'much greater than',
    '∞': 'infinity infinite forever endless lemniscate', '√': 'square root radical root sqrt',
    '∛': 'cube root', '∑': 'sum summation sigma total', '∏': 'product pi big product',
    '∫': 'integral calculus integrate area', '∂': 'partial derivative del curly d', '∇': 'nabla del gradient',
    '∆': 'delta change difference increment triangle', 'Δ': 'delta change difference', 'π': 'pi 3.14 circle constant',
    'Ω': 'omega ohm resistance', 'Ω': 'ohm resistance electricity', 'µ': 'micro mu micron',
    'μ': 'mu micro', 'λ': 'lambda wavelength function', 'θ': 'theta angle', 'α': 'alpha first',
    'β': 'beta second', 'γ': 'gamma', 'σ': 'sigma standard deviation', 'φ': 'phi golden ratio',
    'ε': 'epsilon small', '∅': 'empty set null nothing void', '∈': 'element of in member belongs',
    '∉': 'not element of not in', '⊂': 'subset of', '⊆': 'subset or equal', '∪': 'union cup or',
    '∩': 'intersection cap and', '∀': 'for all every universal quantifier', '∃': 'there exists some existential',
    '∄': 'there does not exist', '¬': 'not negation logical not', '∧': 'and logical and wedge conjunction',
    '∨': 'or logical or vee disjunction', '⊕': 'xor exclusive or direct sum circled plus', '∴': 'therefore thus hence so',
    '∵': 'because since', '⇒': 'implies then double arrow', '⇔': 'if and only if iff equivalent',
    '→': 'right arrow to next maps to then', '←': 'left arrow back previous', '↑': 'up arrow increase',
    '↓': 'down arrow decrease', '↔': 'left right arrow both ways bidirectional', '↕': 'up down arrow vertical',
    '↵': 'return enter carriage return newline', '⏎': 'return enter key newline', '⌘': 'command cmd mac key place of interest',
    '⌥': 'option alt mac key', '⇧': 'shift key', '⌃': 'control ctrl key', '⎋': 'escape esc key',
    '⌫': 'backspace delete erase', '⌦': 'forward delete', '⇥': 'tab key', '⇪': 'caps lock',
    '⏏': 'eject', '⏻': 'power button on off', '⌂': 'house home', '¶': 'pilcrow paragraph mark',
    '§': 'section sign legal law clause', '†': 'dagger death obelisk footnote cross',
    '‡': 'double dagger footnote', '※': 'reference mark note komejirushi', '‽': 'interrobang question exclamation',
    '¡': 'inverted exclamation spanish', '¿': 'inverted question spanish', '«': 'guillemet left angle quote french',
    '»': 'guillemet right angle quote french', '“': 'left double quote smart quote curly open',
    '”': 'right double quote smart quote curly close', '‘': 'left single quote smart curly open',
    '’': 'right single quote apostrophe smart curly close', '′': 'prime minutes feet', '″': 'double prime seconds inches',
    '€': 'euro money currency eur europe', '£': 'pound sterling gbp money currency british uk',
    '¥': 'yen yuan jpy cny money currency japan china', '¢': 'cent cents money', '₹': 'rupee inr india money',
    '₩': 'won krw korea money', '₽': 'ruble rub russia money', '₿': 'bitcoin btc crypto money',
    '₺': 'lira turkish money', '₱': 'peso philippine money', '₪': 'shekel israel money', '₫': 'dong vietnam money',
    '₴': 'hryvnia ukraine money', '₦': 'naira nigeria money', '¤': 'currency generic',
    '✓': 'check mark tick yes done correct ok', '✔': 'heavy check mark tick yes done ok',
    '✗': 'ballot x cross no wrong incorrect', '✘': 'heavy ballot x cross no wrong', '☐': 'ballot box checkbox unchecked empty todo',
    '☑': 'ballot box with check checkbox checked done', '☒': 'ballot box with x checkbox crossed',
    '★': 'black star filled star favorite rating', '☆': 'white star empty star outline rating',
    '♥': 'heart love suit', '♡': 'white heart love outline', '❤': 'heart love red', '♪': 'music note eighth note song',
    '♫': 'music notes beamed song', '♩': 'quarter note music', '♬': 'sixteenth notes music', '♭': 'flat music',
    '♯': 'sharp music hash', '☀': 'sun sunny weather', '☁': 'cloud cloudy weather', '☂': 'umbrella rain',
    '☃': 'snowman winter snow', '❄': 'snowflake snow winter cold', '⚡': 'lightning zap electric voltage',
    '☺': 'smiley smile happy face', '☻': 'black smiley face', '☹': 'frown sad face', '☮': 'peace sign',
    '☯': 'yin yang balance taoism', '☢': 'radioactive radiation nuclear', '☣': 'biohazard danger',
    '⚠': 'warning caution alert', '♻': 'recycle recycling', '♀': 'female woman venus', '♂': 'male man mars',
    '⚧': 'transgender', '☎': 'telephone phone call', '✉': 'envelope email mail letter', '✂': 'scissors cut',
    '✎': 'pencil edit write', '✏': 'pencil edit write', '✒': 'pen nib write', '☛': 'pointing hand right',
    '☞': 'pointing hand right index', '♠': 'spade suit cards', '♣': 'club suit cards', '♦': 'diamond suit cards',
    '½': 'half one half 1/2', '¼': 'quarter one quarter 1/4', '¾': 'three quarters 3/4', '⅓': 'third 1/3',
    '⅔': 'two thirds 2/3', '⅛': 'eighth 1/8', '²': 'squared superscript two power 2', '³': 'cubed superscript three power 3',
    '¹': 'superscript one', '⁰': 'superscript zero', 'ⁿ': 'superscript n power', '℃': 'celsius degrees temperature',
    '℉': 'fahrenheit degrees temperature', 'K': 'kelvin', '№': 'numero number no', 'ℓ': 'liter litre script l',
    '℮': 'estimated sign e mark', 'ℝ': 'real numbers double struck r', 'ℕ': 'natural numbers', 'ℤ': 'integers',
    'ℚ': 'rational numbers', 'ℂ': 'complex numbers', 'ℵ': 'aleph infinity cardinal', 'ℏ': 'h bar planck constant',
    '‰': 'per mille permille per thousand', '‱': 'per ten thousand basis point', '℅': 'care of c/o',
    '∠': 'angle', '⊥': 'perpendicular up tack bottom false', '∥': 'parallel', '∝': 'proportional to',
    '⌀': 'diameter', '△': 'triangle delta', '□': 'white square empty box', '■': 'black square filled box',
    '▪': 'small black square bullet', '●': 'black circle filled dot bullet', '○': 'white circle empty ring',
    '◆': 'black diamond filled', '◇': 'white diamond', '◊': 'lozenge diamond', '▲': 'up triangle filled',
    '▼': 'down triangle filled', '►': 'right pointer play triangle', '◄': 'left pointer triangle',
    '▶': 'play right triangle', '◀': 'left triangle reverse', '█': 'full block solid', '░': 'light shade',
    '▒': 'medium shade', '▓': 'dark shade', ' ': 'non-breaking space nbsp space', '​': 'zero width space zwsp invisible',
    '‍': 'zero width joiner zwj', '‌': 'zero width non-joiner zwnj', ' ': 'thin space',
    ' ': 'em space wide', ' ': 'en space', ' ': 'narrow no-break space', '­': 'soft hyphen shy',
    '　': 'ideographic space full width', 'ß': 'eszett sharp s german', 'æ': 'ash ae ligature',
    'œ': 'oe ligature french', 'ø': 'o slash danish norwegian', 'å': 'a ring swedish', 'ñ': 'n tilde enye spanish',
    'Ñ': 'n tilde enye spanish', 'ç': 'c cedilla french portuguese', 'é': 'e acute french', 'è': 'e grave french',
    'ü': 'u umlaut german', 'ö': 'o umlaut german', 'ä': 'a umlaut german', 'ð': 'eth icelandic',
    'þ': 'thorn icelandic', 'ł': 'l stroke polish', 'ƒ': 'function florin f hook', 'ª': 'feminine ordinal',
    'º': 'masculine ordinal numero', '¦': 'broken bar pipe', '¨': 'diaeresis umlaut', '´': 'acute accent',
    '¯': 'macron overline', '¸': 'cedilla', '¬': 'not sign negation', '⁂': 'asterism', '⁄': 'fraction slash',
    '‹': 'single guillemet left', '›': 'single guillemet right', '„': 'low double quote german',
    '‚': 'low single quote', '‾': 'overline', '‿': 'undertie', '❝': 'heavy quote open', '❞': 'heavy quote close',
    '⟨': 'left angle bracket bra', '⟩': 'right angle bracket ket', '⌈': 'ceiling left', '⌉': 'ceiling right',
    '⌊': 'floor left', '⌋': 'floor right', '⏰': 'alarm clock', '⌛': 'hourglass time wait', '⌚': 'watch time',
    '☕': 'coffee hot beverage tea', '♔': 'white king chess', '♚': 'black king chess', '⚀': 'die one dice',
    '⚅': 'die six dice', '✝': 'latin cross christian', '☪': 'star and crescent islam', '✡': 'star of david jewish',
    '☸': 'dharma wheel buddhism', '🕉': 'om hindu', '☦': 'orthodox cross', '⚖': 'scales justice balance law',
    '⚕': 'medical staff of aesculapius health', '⚓': 'anchor', '⚙': 'gear settings cog', '⚛': 'atom science',
    '✈': 'airplane plane flight travel', '☠': 'skull crossbones danger poison pirate', '⌨': 'keyboard',
    '✍': 'writing hand sign', '❀': 'flower florette', '✿': 'flower blossom', '❦': 'floral heart fleuron',
    '❧': 'rotated floral heart fleuron hedera', '☙': 'reversed rotated floral heart', '⁑': 'two asterisks',
    '✱': 'heavy asterisk', '✳': 'eight spoked asterisk', '✴': 'eight pointed star', '❖': 'diamond minus x',
    '¤': 'currency sign scarab', '‐': 'hyphen', '−': 'minus sign math', '⁓': 'swung dash tilde',
    '〜': 'wave dash', '‖': 'double vertical bar norm', '∣': 'divides', '∤': 'does not divide',
    '⊢': 'turnstile proves entails', '⊨': 'models entails', '⊤': 'top true down tack', '∎': 'end of proof qed tombstone halmos',
    '□': 'empty box square', '⟹': 'long implies', '↦': 'maps to', '∘': 'ring operator compose composition',
    '⊗': 'tensor product circled times', '⋅': 'dot operator multiply', '∗': 'asterisk operator convolution',
    '∼': 'tilde similar', '≅': 'congruent isomorphic approximately equal', '∡': 'measured angle',
    '⊙': 'circled dot sun', '⌐': 'reversed not', '⅀': 'double struck sigma',
}

# Most-used things that aren't on a keyboard, in priority order. Drives the
# "Popular" category and a ranking boost for search.
POPULAR = (
    '© ® ™ ° • … — – € £ ¥ ¢ § ¶ † ‡ ± × ÷ ≠ ≈ ≤ ≥ ∞ √ ∑ π Ω µ Δ ∆ → ← ↑ ↓ ↔ ⇒ ⇔ ✓ ✔ ✗ ✘ ☐ ☑ ☒ '
    '★ ☆ ♥ ♡ ♦ ♣ ♠ ♪ ♫ ☀ ☁ ☂ ☃ ❄ ⚡ ☺ ☹ ☮ ☯ ⚠ ♻ ♀ ♂ ½ ¼ ¾ ⅓ ² ³ ¹ ℃ ℉ № “ ” ‘ ’ « » ‹ › ¿ ¡ '
    '· ‰ ∅ ∈ ∀ ∃ ∴ ∵ ¬ ∧ ∨ ∩ ∪ ⊂ ∫ ∂ ∇ α β γ θ λ σ φ ■ □ ▪ ● ○ ◆ ◇ ▲ ▼ ► ◄ ▶ ◀ █ ░ ▒ ▓ '
    '⌘ ⌥ ⇧ ⌃ ⏎ ↵ ⌫ ⎋ ⇥ é è ê ë á à â ä ã å ç ñ ó ò ô ö õ ø ú ù û ü í ì î ï ß æ œ ¦ ¨ ´ ¯ ¸ ª º'
).split()
POPULAR = list(dict.fromkeys(POPULAR))

KAOMOJI = [
    ('¯\\_(ツ)_/¯', 'Shrug', 'shrug whatever idk dunno meh'),
    ('(╯°□°)╯︵ ┻━┻', 'Table flip', 'table flip angry rage flip'),
    ('┬─┬ノ( º _ ºノ)', 'Put table back', 'table unflip calm restore'),
    ('( ͡° ͜ʖ ͡°)', 'Lenny face', 'lenny face smirk suggestive'),
    ('ಠ_ಠ', 'Look of disapproval', 'disapproval stare judging'),
    ('(ノಠ益ಠ)ノ彡┻━┻', 'Rage table flip', 'table flip rage angry'),
    ('(づ｡◕‿‿◕｡)づ', 'Hug', 'hug cuddle love'),
    ('ʕ•ᴥ•ʔ', 'Bear', 'bear cute animal'),
    ('(ᵔᴥᵔ)', 'Cute bear', 'bear cute happy'),
    ('(•_•) ( •_•)>⌐■-■ (⌐■_■)', 'Deal with it', 'sunglasses cool deal with it'),
    ('(＾▽＾)', 'Happy', 'happy smile joy'),
    ('(T_T)', 'Crying', 'cry sad tears'),
    ('(ಥ﹏ಥ)', 'Sobbing', 'cry sob sad tears'),
    ('(¬‿¬)', 'Smirk', 'smirk sly'),
    ('(✿◠‿◠)', 'Flower smile', 'happy cute flower smile'),
    ('◉_◉', 'Wide eyes', 'shock stare surprised'),
    ('(⊙_☉)', 'Confused', 'confused crazy dizzy'),
    ('(☞ﾟヮﾟ)☞', 'Finger guns', 'finger guns point you'),
    ('ᕦ(ò_óˇ)ᕤ', 'Flex', 'strong flex muscle'),
    ('(ง\'̀-\'́)ง', 'Fight me', 'fight boxing angry'),
    ('♪~ ᕕ(ᐛ)ᕗ', 'Happy walk', 'dance happy walk music'),
    ('(っ˘ڡ˘ς)', 'Yummy', 'yum food tasty'),
    ('(￣ω￣)', 'Content', 'content smug cat'),
    ('(=^･ω･^=)', 'Cat', 'cat kitty meow'),
    ('<(￣︶￣)>', 'Proud', 'proud smug pleased'),
    ('(*^‿^*)', 'Blush', 'blush happy shy'),
    ('(；一_一)', 'Annoyed', 'annoyed unamused'),
    ('¯\\(°_o)/¯', 'Confused shrug', 'shrug confused'),
    ('(҂◡_◡)', 'Tough', 'tough scar'),
    ('┻━┻ ︵ヽ(`Д´)ﾉ︵ ┻━┻', 'Double table flip', 'table flip double angry'),
]

# Thematic tags from the official name: regex -> tags.
DIR = r'(?=.*(?:arrow|pointing|harpoon|triangle|pointer|tack|hand)).*'
THEMES = [
    (r'\barrow|\barrowhead', 'arrow direction pointer'),
    # directions only where the name is about pointing somewhere
    (DIR + r'(leftwards|\bleft\b)', 'left west back previous'), (DIR + r'(rightwards|\bright\b)', 'right east forward next'),
    (DIR + r'(upwards|\bup\b|\bupper\b)', 'up north'), (DIR + r'(downwards|\bdown\b|\blower\b)', 'down south'),
    (r'\bheart', 'love heart'), (r'\bstar\b|\bstars\b', 'star'), (r'\bcheck mark|ballot box with check', 'check tick done yes ok'),
    (r'ballot x|multiplication x|cross mark|saltire|\bx\b', 'cross x no cancel close'),
    (r'\bcircle|\bcircled', 'circle round'), (r'\bsquare', 'square box'), (r'triangle', 'triangle'),
    (r'diamond|lozenge', 'diamond'), (r'\bhexagon|pentagon|octagon|ellipse|rectangle|parallelogram', 'shape polygon'),
    (r'^black ', 'filled solid'), (r'^white ', 'outline hollow'),
    (r'integral', 'calculus integral'), (r'summation', 'sigma sum total'),
    (r'less-than|greater-than|equal|equivalent|identical|approx|similar|congruent|precedes|succeeds', 'compare relation'),
    (r'element of|subset|superset|union|intersection|empty set|contains? as member|complement', 'set theory'),
    (r'logical|for all|there exists|therefore|because|tack|turnstile|models|forces', 'logic'),
    (r'superscript', 'power exponent superscript'), (r'subscript', 'subscript index chemistry'),
    (r'fraction', 'fraction ratio'), (r'roman numeral', 'roman numeral number'),
    (r'parenthesized|circled|negative circled|double circled|squared latin', 'enclosed'),
    (r'box drawings', 'box line border table frame ascii art'), (r'block|shade\b', 'block pixel bar'),
    (r'\bsun\b|cloud|umbrella|snow|comet|lightning|thunder|rain|weather', 'weather'),
    (r'chess', 'chess game board'), (r'playing card|suit', 'cards poker game'), (r'die face', 'dice game random'),
    (r'\bnote\b|musical|\bsharp\b|\bflat\b|natural sign|clef|beamed', 'music'),
    (r'quotation', 'quote quotation marks'), (r'\bdash\b|hyphen', 'dash hyphen line'), (r'bullet', 'bullet list point'),
    (r'\bspace\b|joiner|zero width', 'space invisible whitespace'),
    (r'greek', 'greek letter'), (r' acute| grave| circumflex| tilde| diaeresis| ring above| cedilla| caron| macron| breve| ogonek| stroke| dot above| double acute', 'accent diacritic accented'),
    (r'aries|taurus|gemini|cancer|\bleo\b|virgo|libra|scorpius|sagittarius|capricorn|aquarius|pisces|ophiuchus', 'zodiac astrology horoscope'),
    (r'mercury|venus|earth|mars|jupiter|saturn|uranus|neptune|pluto', 'planet astronomy astrology'),
    (r'male|female|gender|hermaphrodite|transgender|neuter', 'gender'),
    (r'\bcross\b|star of david|crescent|yin yang|\bom\b|dharma|peace|ankh|chi rho|menorah|khanda|torii', 'religion spiritual'),
    (r'warning|radioactive|biohazard|caution|skull', 'warning danger hazard'),
    (r'\bkey\b|command|option|shift|return|escape|eject|power|enter|delete|backspace|keyboard|place of interest', 'keyboard key computer'),
    (r'\bhand\b|finger|index', 'hand pointing'), (r'flower|florette|floral|petal|leaf|rosette', 'flower floral ornament decoration'),
    (r'\bsign\b', 'sign symbol'), (r'currency|dollar|euro|pound|yen|rupee|won|franc|lira|peso|coin|money', 'money currency finance price'),
    (r'\bclock\b|hourglass|watch|timer', 'time'), (r'telephone|envelope|mail', 'communication contact'),
    (r'ornament|fleuron|asterism|dingbat|swash', 'ornament decoration fancy'),
]

STOP = set('of with and the a an for to in on sign symbol letter small capital mark'.split())


def words(s):
    return [w for w in re.split(r'[^a-z0-9]+', s.lower()) if w]


# ---------------------------------------------------------------- categories
# Each symbol code point lands in exactly one (category, sub) for browsing.
CATS = []          # [{id, name, icon, emoji, subs: [[name, [idx...]]]}]
CAT_INDEX = {}


def cat(cid, name, icon, emoji=False):
    c = {'id': cid, 'name': name, 'icon': icon, 'emoji': emoji, 'subs': {}}
    CATS.append(c)
    CAT_INDEX[cid] = c
    return c


cat('recent', 'Recent', '🕘')
cat('popular', 'Popular', '⭐')
cat('alt', 'Alt Codes', '⌨')
cat('punct', 'Punctuation', '¶')
cat('currency', 'Currency', '€')
cat('math', 'Math', '∑')
cat('arrows', 'Arrows', '→')
cat('shapes', 'Shapes', '◆')
cat('checks', 'Checks & Stars', '✓')
cat('box', 'Box & Blocks', '▓')
cat('letters', 'Letters', 'é')
cat('numbers', 'Numbers & Units', '①')
cat('tech', 'Technical', '⌘')
cat('symbols', 'Symbols', '☯')
cat('dingbats', 'Dingbats', '❦')
cat('kaomoji', 'Text Faces', 'ツ')

EMOJI_GROUPS = [
    ('Smileys & Emotion', 'e-smileys', '😀'), ('People & Body', 'e-people', '👋'),
    ('Animals & Nature', 'e-nature', '🐶'), ('Food & Drink', 'e-food', '🍔'),
    ('Travel & Places', 'e-travel', '✈️'), ('Activities', 'e-activities', '⚽'),
    ('Objects', 'e-objects', '💡'), ('Symbols', 'e-symbols', '❤️'), ('Flags', 'e-flags', '🏁'),
]
for g, cid, icon in EMOJI_GROUPS:
    cat(cid, g, icon, emoji=True)


def blk(cp, a, b):
    return a <= cp <= b


def classify(cp, name):
    n = name.lower()
    ch = chr(cp)
    # ---- checks, ballots, stars (cross-block) ----
    if re.search(r'check mark|ballot box|ballot x|ballot script x|^multiplication x|heavy multiplication x|cross mark|saltire', n):
        return 'checks', 'Checks & Crosses'
    if blk(cp, 0x2600, 0x27BF) or blk(cp, 0x2B00, 0x2BFF) or blk(cp, 0x2700, 0x27BF):
        if re.search(r'\bstar\b|\bstars\b|asterisk|sparkle|pinwheel', n) and 'david' not in n and 'crescent' not in n:
            return 'checks', 'Stars & Asterisks'
    # ---- punctuation ----
    if blk(cp, 0x2000, 0x206F) or cp in (0xA0, 0xAD, 0x3000) or blk(cp, 0x2E00, 0x2E7F):
        if re.search(r'space|joiner|zero width|word joiner|separator|invisible|mark$|isolate|embedding|override|function application|invisible', n) and not re.search(r'quotation|reference|dagger', n):
            if re.search(r'space|joiner|width|soft hyphen', n) or cp in (0xA0, 0xAD):
                return 'punct', 'Spaces & Invisible'
            return 'punct', 'Spaces & Invisible'
        if re.search(r'dash|hyphen|bar\b|figure dash|swung', n):
            return 'punct', 'Dashes & Hyphens'
        if re.search(r'quotation|prime|guillemet|apostrophe', n):
            return 'punct', 'Quotes & Primes'
        if re.search(r'bullet|dot|ellipsis|leader|asterism|asterisk', n):
            return 'punct', 'Bullets & Dots'
        if re.search(r'bracket|parenthesis|brace', n):
            return 'punct', 'Brackets'
        if re.search(r'superscript|subscript', n):
            return 'math', 'Superscripts & Subscripts'
        return 'punct', 'Marks & Signs'
    if cp in (0xA0, 0xAD):
        return 'punct', 'Spaces & Invisible'
    # ---- Latin-1 / Latin Extended ----
    if blk(cp, 0xA1, 0xBF) or cp in (0xD7, 0xF7):
        if re.search(r'currency|cent|pound|yen', n):
            return 'currency', 'Currency'
        if cp in (0xB1, 0xD7, 0xF7, 0xAC, 0xB5):
            return 'math', 'Operators'
        if re.search(r'fraction', n):
            return 'math', 'Fractions'
        if re.search(r'superscript', n):
            return 'math', 'Superscripts & Subscripts'
        if re.search(r'quotation', n):
            return 'punct', 'Quotes & Primes'
        if re.search(r'ordinal', n):
            return 'letters', 'Latin Specials & Ligatures'
        if re.search(r'diaeresis|acute|macron|cedilla', n):
            return 'letters', 'Accents & Modifiers'
        if 'middle dot' in n:
            return 'punct', 'Bullets & Dots'
        return 'punct', 'Marks & Signs'
    if blk(cp, 0xC0, 0x24F):
        if re.search(r'with ', n):
            return 'letters', 'Accented Latin'
        return 'letters', 'Latin Specials & Ligatures'
    if blk(cp, 0x2B0, 0x2FF):
        return 'letters', 'Accents & Modifiers'
    if blk(cp, 0x370, 0x3FF):
        return 'letters', 'Greek'
    if blk(cp, 0x20A0, 0x20CF):
        return 'currency', 'Currency'
    if blk(cp, 0x2070, 0x209F):
        return 'math', 'Superscripts & Subscripts'
    if blk(cp, 0x2100, 0x214F):
        if re.search(r'double-struck|script|black-letter|alef|bet|gimel|dalet|planck|turned|n-ary', n):
            return 'math', 'Letterlike'
        return 'numbers', 'Units & Letterlike'
    if blk(cp, 0x2150, 0x218F):
        if 'fraction' in n:
            return 'math', 'Fractions'
        return 'numbers', 'Roman Numerals'
    if blk(cp, 0x2190, 0x21FF) or blk(cp, 0x27F0, 0x27FF) or blk(cp, 0x2900, 0x297F) or (blk(cp, 0x2B00, 0x2BFF) and 'arrow' in n) or (blk(cp, 0x2794, 0x27BF) and 'arrow' in n) or cp in (0x2794,):
        if 'harpoon' in n:
            return 'arrows', 'Harpoons'
        if re.search(r'double|triple|paired|two headed|stacked|quadruple', n) and 'heavy' not in n:
            return 'arrows', 'Double & Multiple'
        if re.search(r'curv|circle|clockwise|anticlockwise|hook|loop|semicircle|wave|zigzag|corner|tip|turn|return|u-turn|bend', n):
            return 'arrows', 'Curved & Turning'
        if re.search(r'heavy|wide|feathered|wedge|outlined|shadowed|3d|teardrop|drafting|black|white|triangle-headed|bold', n) or blk(cp, 0x2794, 0x27BF) or blk(cp, 0x2B00, 0x2BFF):
            return 'arrows', 'Heavy & Decorative'
        return 'arrows', 'Simple'
    if blk(cp, 0x2200, 0x22FF) or blk(cp, 0x27C0, 0x27EF) or blk(cp, 0x2980, 0x2AFF):
        if re.search(r'element|subset|superset|union|intersection|empty set|contains? as member|complement', n):
            return 'math', 'Sets'
        if re.search(r'logical|for all|exist|therefore|because|tack|turnstile|not sign|models|forces|true|xor|nand|nor\b', n):
            return 'math', 'Logic'
        if re.search(r'less|greater|equal|equivalent|identical|approx|similar|congruent|precedes|succeeds|proportional|asymptotic|tilde', n):
            return 'math', 'Relations'
        if re.search(r'integral|summation|product|root|infinity|partial|nabla|increment|derivative|contour|coproduct', n):
            return 'math', 'Calculus & Big Operators'
        if re.search(r'angle|parallel|perpendicular|right triangle|spherical|measured|diameter|ratio|proportion|geometric', n):
            return 'math', 'Geometry'
        if re.search(r'bracket|parenthesis|fence|brace|ceiling|floor', n):
            return 'math', 'Brackets & Fences'
        if blk(cp, 0x2200, 0x22FF):
            return 'math', 'Operators'
        return 'math', 'Extended Math'
    if blk(cp, 0x2300, 0x23FF):
        if re.search(r'place of interest|option|shift|return|erase|escape|eject|power|keyboard|delete|alternative key|enter|command|tab|clear|print|helm|broken circle|control|up arrowhead|caps|composition|alarm|hourglass|watch|stopwatch|timer|play|pause|stop|record|fast|rewind|skip|track', n) or cp in (0x2318, 0x2325, 0x2303, 0x238B, 0x23CE):
            return 'tech', 'Keyboard & Media'
        if re.search(r'ceiling|floor|integral|bracket|parenthesis|brace|summation|radical|corner|angle', n):
            return 'math', 'Brackets & Fences'
        return 'tech', 'Misc Technical'
    if blk(cp, 0x2460, 0x24FF) or blk(cp, 0x2776, 0x2793):
        if re.search(r'digit|number|\bten\b|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|zero|full stop', n):
            return 'numbers', 'Enclosed Numbers'
        return 'letters', 'Enclosed Letters'
    if blk(cp, 0x2500, 0x257F):
        return 'box', 'Box Drawing'
    if blk(cp, 0x2580, 0x259F):
        return 'box', 'Blocks & Shades'
    if blk(cp, 0x25A0, 0x25FF) or blk(cp, 0x2B00, 0x2BFF):
        if re.search(r'square|rectangle|parallelogram', n):
            return 'shapes', 'Squares & Rectangles'
        if re.search(r'circle|ellipse|bullseye|fisheye|circular|half moon', n):
            return 'shapes', 'Circles'
        if re.search(r'triangle|pointer', n):
            return 'shapes', 'Triangles'
        if re.search(r'diamond|lozenge', n):
            return 'shapes', 'Diamonds'
        if blk(cp, 0x2B00, 0x2BFF) and not re.search(r'pentagon|hexagon|octagon|shape|horizontal|vertical|bar|block', n):
            return 'symbols', 'Miscellaneous'
        return 'shapes', 'Other Shapes'
    if blk(cp, 0x2600, 0x26FF) or blk(cp, 0x1F000, 0x1F0FF):
        if re.search(r'chess|playing card|suit|die face|draughts|domino|mahjong|shogi|go marker', n):
            return 'symbols', 'Games & Cards'
        if re.search(r'aries|taurus|gemini|cancer|\bleo\b|virgo|libra|scorpius|sagittarius|capricorn|aquarius|pisces|mercury|venus|earth|mars|jupiter|saturn|uranus|neptune|pluto|conjunction|opposition|ascending node|descending node|sun\b|moon|comet|ceres|pallas|juno|vesta|chiron|astronomical', n) and not re.search(r'cloud|rain|behind', n):
            return 'symbols', 'Zodiac & Astronomy'
        if re.search(r'cloud|rain|umbrella|snow|thunder|lightning|weather|sun|fog|wind|hot springs|high voltage', n):
            return 'symbols', 'Weather & Nature'
        if re.search(r'\bcross\b|star of david|crescent|yin yang|\bom\b|dharma|peace|ankh|chi rho|menorah|khanda|torii|church|mosque|shinto|farsi|adi shakti|bahai|pentagram|trigram|digram|monogram|cross of', n):
            return 'symbols', 'Religious & Cultural'
        if re.search(r'male|female|gender|hermaphrodite|transgender|neuter|marriage|divorce|engaged|unmarried', n):
            return 'symbols', 'Gender & Relationships'
        if re.search(r'note|music|sharp|flat|natural', n):
            return 'symbols', 'Music'
        if re.search(r'hand|finger|writing|scissors|pencil|nib|telephone|envelope|smiling|frowning|face|smiley', n):
            return 'symbols', 'Hands, Faces & Objects'
        if re.search(r'warning|radioactive|biohazard|caution|skull|recycl|high voltage|no entry|caduceus|staff|medical|atom|gear|scales|anchor|alembic|crossed swords', n):
            return 'symbols', 'Warning & Science'
        return 'symbols', 'Miscellaneous'
    if blk(cp, 0x2700, 0x27BF):
        if re.search(r'hand|finger|writing|scissors|pencil|nib|envelope|telephone|airplane|taxi', n):
            return 'symbols', 'Hands, Faces & Objects'
        if re.search(r'quotation|ornament|bracket', n):
            return 'dingbats', 'Ornaments & Quotes'
        if re.search(r'florette|flower|petal|snowflake|sparkle|heart|rotated|rosette|propeller', n):
            return 'dingbats', 'Florettes & Hearts'
        if re.search(r'dingbat (?:negative )?circled|digit|number', n):
            return 'numbers', 'Enclosed Numbers'
        return 'dingbats', 'Other Dingbats'
    if blk(cp, 0x1D100, 0x1D1FF):
        return 'symbols', 'Music'
    if blk(cp, 0x1D400, 0x1D7FF):
        return 'math', 'Letterlike'
    if blk(cp, 0x1F100, 0x1F1FF):
        if 'regional indicator' in n:
            return None
        return 'letters', 'Enclosed Letters'
    if blk(cp, 0x1F650, 0x1F67F):
        return 'dingbats', 'Ornaments & Quotes'
    if blk(cp, 0x1F780, 0x1F7FF):
        return 'shapes', 'Other Shapes'
    if blk(cp, 0x1F800, 0x1F8FF):
        return 'arrows', 'Heavy & Decorative'
    return None


RANGES = [
    (0xA0, 0xBF), (0xC0, 0x17F), (0x192, 0x192), (0x1F0, 0x1F0), (0x218, 0x21B), (0x259, 0x259), (0x2B0, 0x2FF), (0x391, 0x3C9),
    (0x2000, 0x206F), (0x2070, 0x209F), (0x20A0, 0x20C0), (0x2100, 0x214F), (0x2150, 0x218B),
    (0x2190, 0x21FF), (0x2200, 0x22FF), (0x2300, 0x23FF), (0x2460, 0x24FF), (0x2500, 0x259F),
    (0x25A0, 0x25FF), (0x2600, 0x26FF), (0x2700, 0x27BF), (0x27C0, 0x27EF), (0x27F0, 0x27FF),
    (0x2900, 0x297F), (0x2980, 0x29FF), (0x2A00, 0x2AFF), (0x2B00, 0x2BFF), (0x2E00, 0x2E5D),
    (0x3000, 0x3000), (0x1D11E, 0x1D129), (0x1D15D, 0x1D164), (0x1F000, 0x1F02B), (0x1F0A0, 0x1F0F5),
    (0x1F100, 0x1F1AD),
    # double-struck capitals / fraktur etc. from math alphanumerics: a useful taste
    (0x1D538, 0x1D56B),
]
SKIP_NAME = re.compile(r'^(combining|variation selector)|private use|<control>|deprecated|inhibit|activate|nominal digit|national digit|interlinear|object replacement|^tag ')


def nice(name):
    s = name.lower()
    return s[:1].upper() + s[1:]


# ---------------------------------------------------------------- items
ITEMS = []          # dicts
BY_CHAR = {}


def add_item(ch, name, kw, tags, cid, sub, emoji=False):
    if ch in BY_CHAR and not emoji:
        return BY_CHAR[ch]
    it = {'c': ch, 'n': name, 'k': kw, 't': tags, 'e': emoji, 'i': len(ITEMS)}
    ITEMS.append(it)
    if not emoji:
        BY_CHAR[ch] = it['i']
    if cid:
        CAT_INDEX[cid]['subs'].setdefault(sub, []).append(it['i'])
    return it['i']


def kw_join(*parts, exclude=()):
    seen, out = set(exclude), []
    for p in parts:
        for w in (p.split() if isinstance(p, str) else p):
            w = w.lower().strip()
            if w and w not in seen and w not in STOP:
                seen.add(w)
                out.append(w)
    return ' '.join(out)


def theme_tags(name):
    n = name.lower()
    out = []
    for rx, tags in THEMES:
        if re.search(rx, n):
            out.append(tags)
    return ' '.join(out)


# Symbols
for a, b in RANGES:
    for cp in range(a, b + 1):
        name = NAMES.get(cp)
        if not name or SKIP_NAME.search(name.lower()):
            continue
        ch = chr(cp)
        if ch.isalnum() and cp < 0x80:
            continue
        r = classify(cp, name)
        if not r:
            continue
        cid, sub = r
        cl, tts = cldr(ch)
        nm = nice(name)
        nwords = words(name)
        primary = kw_join(ALIASES.get(ch, ''), [x for c in cl for x in words(c)], exclude=nwords)
        secondary = kw_join(theme_tags(name), words(CAT_INDEX[cid]['name']), words(sub),
                            exclude=set(nwords) | set(primary.split()))
        add_item(ch, nm, primary, secondary, cid, sub)

# Anything in ALIASES / POPULAR / alt tables not yet captured (e.g. ASCII-adjacent).
for ch in list(ALIASES) + POPULAR + list(ALT):
    if ch in BY_CHAR or len(ch) != 1:
        continue
    cp = ord(ch)
    name = NAMES.get(cp)
    if not name or cp < 0xA0 and cp != 0x7F:
        continue
    r = classify(cp, name) or ('symbols', 'Miscellaneous')
    cl, _ = cldr(ch)
    nwords = words(name)
    primary = kw_join(ALIASES.get(ch, ''), [x for c in cl for x in words(c)], exclude=nwords)
    add_item(ch, nice(name), primary, kw_join(theme_tags(name), exclude=nwords), r[0], r[1])

# Text faces
for txt, name, kw in KAOMOJI:
    add_item(txt, name, kw, 'kaomoji text face emoticon ascii art japanese', 'kaomoji', 'Text Faces')

# Emoji
SUBGROUP_NICE = {
    'face-smiling': 'Smiling', 'face-affection': 'Affection', 'face-tongue': 'Tongue', 'face-hand': 'Hands on face',
    'face-neutral-skeptical': 'Neutral & skeptical', 'face-sleepy': 'Sleepy', 'face-unwell': 'Unwell',
    'face-hat': 'Hats', 'face-glasses': 'Glasses', 'face-concerned': 'Concerned', 'face-negative': 'Negative',
    'face-costume': 'Costume', 'cat-face': 'Cat faces', 'monkey-face': 'Monkeys', 'heart': 'Hearts',
    'emotion': 'Emotion', 'hand-fingers-open': 'Open hands', 'hand-fingers-partial': 'Partial fingers',
    'hand-single-finger': 'Pointing', 'hand-fingers-closed': 'Closed hands', 'hands': 'Hands',
    'hand-prop': 'Hand props', 'body-parts': 'Body parts', 'person': 'People', 'person-gesture': 'Gestures',
    'person-role': 'Roles & jobs', 'person-fantasy': 'Fantasy', 'person-activity': 'Activities',
    'person-sport': 'Sports', 'person-resting': 'Resting', 'family': 'Family', 'person-symbol': 'Person symbols',
    'animal-mammal': 'Mammals', 'animal-bird': 'Birds', 'animal-amphibian': 'Amphibians', 'animal-reptile': 'Reptiles',
    'animal-marine': 'Marine', 'animal-bug': 'Bugs', 'plant-flower': 'Flowers', 'plant-other': 'Plants',
    'food-fruit': 'Fruit', 'food-vegetable': 'Vegetables', 'food-prepared': 'Prepared food', 'food-asian': 'Asian food',
    'food-marine': 'Seafood', 'food-sweet': 'Sweets', 'drink': 'Drinks', 'dishware': 'Dishware',
    'place-map': 'Maps', 'place-geographic': 'Geographic', 'place-building': 'Buildings', 'place-religious': 'Religious places',
    'place-other': 'Other places', 'transport-ground': 'Ground transport', 'transport-water': 'Water transport',
    'transport-air': 'Air transport', 'hotel': 'Hotel', 'time': 'Time', 'sky & weather': 'Sky & weather',
    'event': 'Events', 'award-medal': 'Awards', 'sport': 'Sports', 'game': 'Games', 'arts & crafts': 'Arts & crafts',
    'clothing': 'Clothing', 'sound': 'Sound', 'music': 'Music', 'musical-instrument': 'Instruments', 'phone': 'Phone',
    'computer': 'Computer', 'light & video': 'Light & video', 'book-paper': 'Books & paper', 'money': 'Money',
    'mail': 'Mail', 'writing': 'Writing', 'office': 'Office', 'lock': 'Locks', 'tool': 'Tools', 'science': 'Science',
    'medical': 'Medical', 'household': 'Household', 'other-object': 'Other objects', 'transport-sign': 'Transport signs',
    'warning': 'Warning', 'arrow': 'Arrows', 'religion': 'Religion', 'zodiac': 'Zodiac', 'av-symbol': 'AV symbols',
    'gender': 'Gender', 'math': 'Math', 'punctuation': 'Punctuation', 'currency': 'Currency', 'other-symbol': 'Other symbols',
    'keycap': 'Keycaps', 'alphanum': 'Alphanumeric', 'geometric': 'Geometric', 'flag': 'Flags',
    'country-flag': 'Country flags', 'subdivision-flag': 'Subdivision flags',
}
FLAG_ALIASES = {
    'us': 'usa america american', 'gb': 'uk britain british england', 'ae': 'uae', 'kr': 'korea',
    'kp': 'korea', 'cn': 'china prc', 'tw': 'taiwan', 'ru': 'russia', 'de': 'germany', 'nl': 'holland dutch',
    'ch': 'swiss', 'eu': 'europe', 'un': 'united nations',
}
EMOJI_GROUP_ID = {g: cid for g, cid, _ in EMOJI_GROUPS}
SKIN = re.compile('[\U0001F3FB-\U0001F3FF]')
group = sub = None
emoji_count = 0
for line in open(src('emoji-test.txt'), encoding='utf-8'):
    if line.startswith('# group:'):
        group = line.split(':', 1)[1].strip()
        continue
    if line.startswith('# subgroup:'):
        sub = line.split(':', 1)[1].strip()
        continue
    if not line.strip() or line.startswith('#') or 'fully-qualified' not in line:
        continue
    if group not in EMOJI_GROUP_ID:
        continue
    m = re.match(r'([0-9A-F ]+);\s*fully-qualified\s*#\s*(\S+)\s+E(\d+\.\d+)\s+(.*)$', line)
    if not m:
        continue
    ch, ver, name = m.group(2), float(m.group(3)), m.group(4).strip()
    if ver > MAX_EMOJI_VERSION or SKIN.search(ch):
        continue
    cl, _ = cldr(ch)
    nwords = words(name)
    subn = SUBGROUP_NICE.get(sub, sub.replace('-', ' ').capitalize())
    primary = kw_join([x for c in cl for x in words(c)], exclude=nwords)
    secondary = kw_join('emoji', words(group), words(subn), theme_tags(name),
                        exclude=set(nwords) | set(primary.split()))
    if group == 'Flags':
        # regional-indicator pairs -> ISO code ("us", "gb") as a tag
        iso = ''.join(chr(ord(x) - 0x1F1E6 + 97) for x in ch if 0x1F1E6 <= ord(x) <= 0x1F1FF)
        if iso:
            primary = kw_join(iso, FLAG_ALIASES.get(iso, ''), primary)
    add_item(ch, name[:1].upper() + name[1:], primary, secondary, EMOJI_GROUP_ID[group], subn, emoji=True)
    emoji_count += 1

# Popular & Alt Codes memberships (references, not new items)
for ch in POPULAR:
    if ch in BY_CHAR:
        CAT_INDEX['popular']['subs'].setdefault('Popular', []).append(BY_CHAR[ch])
low = [(int(code), ch) for ch, codes in ALT.items() for code in codes if not code.startswith('0')]
win = [(int(code), ch) for ch, codes in ALT.items() for code in codes if code.startswith('0')]
for _, ch in sorted(low):
    if ch in BY_CHAR:
        CAT_INDEX['alt']['subs'].setdefault('Alt + 1–255 (any keyboard layout, DOS)', []).append(BY_CHAR[ch])
for _, ch in sorted(win):
    if ch in BY_CHAR:
        CAT_INDEX['alt']['subs'].setdefault('Alt + 0128–0255 (Windows)', []).append(BY_CHAR[ch])

# ---------------------------------------------------------------- ranking
# 0..99 prior: popular symbols (by list position) > frequently used emoji >
# alt-code chars > other emoji / aliased symbols > ordinary > obscure blocks.
POPULAR_EMOJI = (
    '😂 ❤️ 🤣 👍 😭 🙏 😘 🥰 😍 😊 🎉 😁 💕 🥺 😅 🔥 ☺️ 🤦 ♥️ 🤷 🙄 😆 🤗 😉 🎂 🤔 👏 🙂 😳 🥳 😎 👌 💜 '
    '😔 💪 ✨ 💖 👀 😋 😏 😢 👉 💗 😩 💯 🌹 💞 🎈 💙 😃 😡 💐 😜 🙈 🤞 😄 🤤 🙌 🤪 ❣️ 😀 💋 💀 👇 💔 '
    '😌 💓 🤩 🙃 😬 😱 😴 🤭 😐 🌞 😒 😇 🌸 😈 🎶 ✌️ 🎊 🥵 😞 💚 ☀️ 🖤 💰 😚 👑 🎁 💥 🙋 ☹️ 😑 🥴 👈 '
    '💩 ✅ 👋 🤝 🚀 ⭐ ❌ ⚠️ 📌 📅 💡 📝 🎯 🏆 ☕ 🍕 🐶 🐱 🌈 ⚡ 💬 🔗 📎 🔒 🔑 ⏰ 📞 ✉️ 🏠 🚗 ✈️ 🌍'
).split()
pop_pos = {ch: i for i, ch in enumerate(POPULAR)}
emo_pos = {ch: i for i, ch in enumerate(POPULAR_EMOJI)}
OBSCURE = re.compile(r'Extended Math|Letterlike|Heavy & Decorative|Other Shapes|Miscellaneous|Accents & Modifiers|Enclosed Letters')
item_sub = {}
for c in CATS:
    for s_, idxs in c['subs'].items():
        for ix in idxs:
            item_sub.setdefault(ix, s_)
for it in ITEMS:
    ch = it['c']
    if not it['e'] and ch in pop_pos:
        it['p'] = 99 - pop_pos[ch] * 30 // len(POPULAR)
    elif it['e'] and ch in emo_pos:
        it['p'] = 85 - emo_pos[ch] * 25 // len(POPULAR_EMOJI)
    elif not it['e'] and ch in ALT:
        it['p'] = 55
    elif it['e'] or ch in ALIASES:
        it['p'] = 45
    elif OBSCURE.search(item_sub.get(it['i'], '')):
        it['p'] = 10
    else:
        it['p'] = 30

# Inside a browse sub-category, well-known characters (popular, aliased or
# with an Alt code) come first; the rest stay in code-point order. Subs where
# code-point order IS the meaning (alphabets, numbering, tables) are left alone.
KEEP_ORDER = re.compile(r'Alt \+|Popular|Box Drawing|Blocks|Enclosed|Roman|Fractions|Superscripts|Greek|Accented|Text Faces')
for c in CATS:
    if c['emoji']:
        continue
    for s_, idxs in c['subs'].items():
        if not KEEP_ORDER.search(s_):
            idxs.sort(key=lambda ix: 0 if ITEMS[ix]['p'] >= 45 else 1)

# ---------------------------------------------------------------- emit
def clean(s):
    return s.replace('\t', ' ').replace('\n', ' ')


lines = []
for it in ITEMS:
    ch = it['c']
    flags = ('e' if it['e'] else '') + str(it['p'])
    lines.append('\t'.join([
        clean(ch), clean(it['n']), clean(it['k']), clean(it['t']), flags,
        ' '.join(ALT.get(ch, [])) if not it['e'] else '',
        MAC.get(ch, '') if not it['e'] else '',
        ENTITY.get(ch, '') if not it['e'] else '',
    ]))

cats_out = []
for c in CATS:
    cats_out.append({
        'id': c['id'], 'name': c['name'], 'icon': c['icon'], 'emoji': c['emoji'],
        'subs': [[s, idxs] for s, idxs in c['subs'].items()],
    })

out = os.path.join(HERE, 'symbols-data.js')
with open(out, 'w', encoding='utf-8') as f:
    f.write('/* Generated by build-data.py — do not edit by hand.\n'
            '   Sources: Unicode UCD names, emoji-test.txt, CLDR annotations (Unicode license),\n'
            '   plus curated aliases, themes, alt codes and categories (see build-data.py).\n'
            '   items: one per line, tab-separated:\n'
            '     char, name, keywords, tags, flags (e=emoji + 0-99 rank), alt codes, mac keys, html entity */\n')
    f.write('window.__cadeSymbolsData = {\n')
    f.write('items: ' + json.dumps('\n'.join(lines), ensure_ascii=False) + ',\n')
    f.write('cats: ' + json.dumps(cats_out, ensure_ascii=False, separators=(',', ':')) + '\n};\n')

print('items', len(ITEMS), 'emoji', emoji_count, 'bytes', os.path.getsize(out))
for c in CATS:
    print(' ', c['name'], [(s, len(v)) for s, v in c['subs'].items()])
