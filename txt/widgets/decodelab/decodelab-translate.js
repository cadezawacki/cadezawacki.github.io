/* Decode Lab — on-device translation into English (lazy-loaded by decodelab.js).
 *
 * Engines, best first:
 *   1. Chrome's built-in Translator / LanguageDetector APIs (desktop Chrome
 *      138+): no download on our side, Chrome manages its own models.
 *   2. Bergamot — the engine inside Firefox Translations (MPL-2.0) — as
 *      WebAssembly in decodelab-translate-worker.js, with Mozilla's int8
 *      models (22–55 MB per language). The main path on iPhone Safari.
 *
 * Model sources (all CORS-enabled; every file is verified in the worker
 * against the SHA-256 that Mozilla publishes for it in Remote Settings,
 * collection "translations-models", so a mirror cannot alter a model):
 *   S  bergamot.s3.amazonaws.com — the browsermt/Mozilla Bergamot bucket
 *   M  huggingface.co/manateelazycat/firefox-translations-93-pairs (MPL-2.0 mirror, pinned commit)
 *   T  huggingface.co/TiberiuCristianLeon/Bergamot (mirror, pinned commit)
 * Mozilla's own CDN / GCS bucket send no CORS headers, hence the mirrors.
 * Engine: @browsermt/bergamot-translator 0.4.9 (npm, via jsDelivr, pinned + hashed).
 *
 * Opus-MT (transformers.js) is not used: Bergamot already covers every
 * language asked for, and Opus-MT would add a ~10 MB runtime plus ~100 MB
 * per language for no extra coverage.
 *
 * Pure helpers (chunking, detection, registry) are also exported for node
 * tests: module.exports = { create, chunkText, guessLang, langFromName, LANGS, ENGINE }. */
(function (root) {
  'use strict';

  var CACHE = 'cade-translate-v1'; // must match decodelab-translate-worker.js
  var BASES = {
    S: 'https://bergamot.s3.amazonaws.com/models/',
    M: 'https://huggingface.co/manateelazycat/firefox-translations-93-pairs/resolve/32fd180b178abf56cb0ff01410ab23d470074966/',
    T: 'https://huggingface.co/TiberiuCristianLeon/Bergamot/resolve/18008da9d2922dde09dae47f5fee71cac4253701/',
  };
  // Self-hosted copies of what the two Hugging Face mirrors serve, on GitHub
  // Pages under this app's own domain (repos txt-models-a / txt-models-b,
  // filled by their "Fetch models" Action, SHA-256-checked). Tried first; the
  // original URL stays the cache key (languages downloaded before stay
  // downloaded) and is only fetched if the self-hosted copy fails.
  var SELF = {
    M: 'https://cadezawacki.github.io/txt-models-a/',
    T: 'https://cadezawacki.github.io/txt-models-b/',
  };
  var ENG = 'https://cdn.jsdelivr.net/npm/@browsermt/bergamot-translator@0.4.9/worker/';
  var ENGINE = {
    glue: { u: ENG + 'bergamot-translator-worker.js', s: 80474, h: '748b2418418a2ffc6e70721aeb10098d8e6fb589ea156b91f4ae8bc3490d8f7a' },
    wasm: { u: ENG + 'bergamot-translator-worker.wasm', s: 5174294, h: '95a2b58dd6773bf1b3f345d71f9149928b9f75f4ec9c9064c0b3e42c298671b2' },
  };
  // [code, English name, native name, Mozilla model version, files: [base, path, bytes, sha256]]
  // Generated from Mozilla Remote Settings + the mirrors' LFS hashes; the
  // smallest release-channel model whose every file has a verified source.
  var RAW = [
    ['es', 'Spanish', 'Español', '1.0', { model: ['S', 'esen/model.esen.intgemm.alphas.bin', 17140755, '4b6b7f451094aaa447d012658af158ffc708fc8842dde2f871a58404f5457fe0'], lex: ['S', 'esen/lex.50.50.esen.s2t.bin', 3860888, 'f11a2c23ef85ab1fee1c412b908d69bc20d66fd59faa8f7da5a5f0347eddf969'], vocab: ['S', 'esen/vocab.esen.spm', 825463, '909b1eea1face0d7f90a474fe29a8c0fef8d104b6e41e65616f864c964ba8845'] }],
    ['fr', 'French', 'Français', '1.0', { model: ['S', 'fren/model.intgemm.alphas.bin', 17140961, '185f76d24c2d400fe4ea0cb2487df77722641b97a3ef10633872e8a7fdf40e09'], lex: ['S', 'fren/lex.s2t.bin', 8818768, '3148abf21ea98a4d69d0e4504e0d68a6c060204a9b9a39b76855aee1d5b2c8ea'], vocab: ['S', 'enfr/vocab.fren.spm', 831382, '4c84b95b62c930f0791466d73eb996841eef474c96d0c2f0e6c6d80640f2005a'] }],
    ['de', 'German', 'Deutsch', '1.0', { model: ['S', 'deen/model.deen.intgemm.alphas.bin', 17140837, '1980225d00dc5645491777accff5b3c9d20b92eff67a25135f1cf8fe2ed8fb8f'], lex: ['S', 'deen/lex.50.50.deen.s2t.bin', 5047568, '2f7c0f7bbce97ae5b52454074a892ba7b7610fb98e3c5d341e4ca79f0850c4de'], vocab: ['S', 'ende/vocab.deen.spm', 784269, '417668f2ed297970febafb5b079a9d5ebc4ed0b3550ac8386d67a90473a09bd7'] }],
    ['it', 'Italian', 'Italiano', '2.0', { model: ['M', 'iten/model.iten.intgemm.alphas.bin', 31561787, '21b70978ce2f3b4da7a06b5de86a09abe3acd30b9eee1b2ebb3582b9bad790bf'], lex: ['M', 'iten/lex.50.50.iten.s2t.bin', 4713616, '0700d6d70b30490e68ff9deca0b45b80310745b491855bde3a13e1692d0cbce1'], vocab: ['M', 'iten/vocab.iten.spm', 812724, '3ef0211d4ae6db21440892f180f2019fe2bfc110a330ffa9d2eca9665e4f2bc5'] }],
    ['pt', 'Portuguese', 'Português', '2.0', { model: ['M', 'pten/model.pten.intgemm.alphas.bin', 31561787, '7b854f1ec5a485dd33efd7c1bc01dd7d5a57f566957c5e47722af333f0ce9157'], lex: ['M', 'pten/lex.50.50.pten.s2t.bin', 4634492, '2685d8b6530be92a4db4cc61f15a097eb114552be15cb6c1699e9d2d99d24470'], vocab: ['M', 'pten/vocab.pten.spm', 816726, 'd9f46182823d5bbc84201252b2dfcac28f63e561f0ec827ed858f241864c9def'] }],
    ['nl', 'Dutch', 'Nederlands', '2.0', { model: ['M', 'nlen/model.nlen.intgemm.alphas.bin', 31561787, 'ff987741ff15a5d94fff16cbef28f2b0a85a6e9547d982fad60ac09d16d11270'], lex: ['M', 'nlen/lex.50.50.nlen.s2t.bin', 4862412, '811ac8f9dcbd12706e2d73a7057a7bbe6b9f0607d15170ffe9439977e8229b41'], vocab: ['M', 'nlen/vocab.nlen.spm', 807708, 'c09588ca5662b230ed65bd39a07f58d9f7dd21c3a19e4aeb1bff39bf3b297c56'] }],
    ['ru', 'Russian', 'Русский', '1.1', { model: ['M', 'ruen/model.ruen.intgemm.alphas.bin', 17141051, 'b1d85c13cfbb05e1d326dd6f0fb5ef270a2011b547450260f96567a93f446c94'], lex: ['M', 'ruen/lex.50.50.ruen.s2t.bin', 4483844, 'f654693577505fd38b1f3d220cdd4ffffbb45afb900a60cf751f0724eadc74e0'], vocab: ['M', 'ruen/vocab.ruen.spm', 905257, '93bdc941b16e523695c319f74778bca9fd8b75a25ad75020cdc98aef74cdc0fc'] }],
    ['uk', 'Ukrainian', 'Українська', '1.1', { model: ['M', 'uken/model.uken.intgemm.alphas.bin', 17141051, '2e7b8bc9d2569d8b4ae244e964cdc343a0aa3735cc83ecb664be84a37cb45f48'], lex: ['M', 'uken/lex.50.50.uken.s2t.bin', 3914120, '32b5e0df493671a223cb5cb32430181cbb7fe6b5562c91dbc3d35410d37e5ff6'], vocab: ['M', 'uken/vocab.uken.spm', 886410, '8b51480dfc4ca2d7a08d2bfdaa9e57353ca97e6cf3d5f9aba4c0179d3665bfc0'] }],
    ['pl', 'Polish', 'Polski', '1.0', { model: ['M', 'plen/model.plen.intgemm.alphas.bin', 17140899, '172a5f1d44bf8dd6a6eec3868b13b33ce265f3530e898fe11a80b739b821726e'], lex: ['M', 'plen/lex.50.50.plen.s2t.bin', 4898024, '863afade0ba058fb0173fedef3d1fb14d0dcabc24c3b4584cb1fed8f84d6d879'], vocab: ['M', 'enpl/vocab.enpl.spm', 822587, 'a1d27e6f5c0d29f406364ebf0382949d1c0affc750cec4380f3173150552f43e'] }],
    ['tr', 'Turkish', 'Türkçe', '1.0', { model: ['M', 'tren/model.tren.intgemm.alphas.bin', 17140836, 'bd18594ac5a7f1d9997e7ea5bd80272082219cf8b1ce604766e4f207eb86abbf'], lex: ['M', 'tren/lex.50.50.tren.s2t.bin', 4662492, 'd3374ab5267a73ee1aa1d926a298bd349426835f40856991ee959bc5cd4f9fce'], vocab: ['M', 'tren/vocab.tren.spm', 811353, 'ed328e589a3ccd70fd3ce7773fc3c01d8b7b18c687464cacf17fd40a8c0daadd'] }],
    ['zh-Hans', 'Chinese (Simplified)', '简体中文', '2.1', { model: ['T', 'base-memory/zhen/model.zhen.intgemm.alphas.bin', 43977787, '5cd149601802fc8a18124a1c1306144dbbedc058630c4ddb2d53aa76fa9c7c06'], lex: ['T', 'base-memory/zhen/lex.50.50.zhen.s2t.bin', 9219192, '8524dd4c93ffd7f0ae7be32f77a7c14fea7cdbbebe34ea6ad0ec368d5ddd8b13'], vocab: ['M', 'zhen/vocab.zhen.spm', 1359697, 'dff594318ab7d8b7b60b844ab98ebe6b932ae8045fab15235404c787715965b3'] }],
    ['zh-Hant', 'Chinese (Traditional)', '繁體中文', '2.0', { model: ['T', 'base-memory/zh_hanten/model.zh_hanten.intgemm.alphas.bin', 43849787, '0aee91790894458f5d367551f6edcd4c9cb97852c34f221bcbf9f4701ebcf0cd'], lex: ['T', 'base-memory/zh_hanten/lex.50.50.zh_hanten.s2t.bin', 6385944, 'aa7daf6cfc85c0cd2c10e2944d66f6da55497c9c6408789f3adfded4074c2fb1'], srcvocab: ['T', 'base-memory/zh_hanten/srcvocab.zh_hanten.spm', 769669, '5cc6a76611dbf86219f109141533606b15ecb34eee83673bb86b2c16b14734db'], trgvocab: ['T', 'base-memory/zh_hanten/trgvocab.zh_hanten.spm', 812572, '7bf002db37c10d3b114cc5588d7fdcb16c57d0fd1e2c34354c22cc9f0b6c3c29'] }],
    ['ja', 'Japanese', '日本語', '2.1', { model: ['T', 'base-memory/jaen/model.jaen.intgemm.alphas.bin', 43977787, '3a603e20bfe1be86071913f9e23ab5129075bc0a8490151020ac4821e4f17302'], lex: ['T', 'base-memory/jaen/lex.50.50.jaen.s2t.bin', 9348172, '525f412f0d210536c2933c78ae395fa0bf2b5ee6cc5dda61ebc2e79410ebaee4'], vocab: ['M', 'jaen/vocab.jaen.spm', 1443222, '5cb217758bae05877bb3f0c2f612e4e7c1e4cb03c10db11f4a47098d7ae62919'] }],
    ['ko', 'Korean', '한국어', '2.1', { model: ['T', 'base-memory/koen/model.koen.intgemm.alphas.bin', 43977787, '7cb30cbc0a86e242084756445268a2346136771c92b884d9b4ebb077f67d5507'], lex: ['T', 'base-memory/koen/lex.50.50.koen.s2t.bin', 8617516, 'b26291f063ce216a74239275f0485534a38111203e59d42a2a56ba62d6eeb196'], vocab: ['M', 'koen/vocab.koen.spm', 1410063, '1c72b740ab793cdc3a8f16913dd6b4e806c77421077dd2d85edeb7be38418598'] }],
    ['ar', 'Arabic', 'العربية', '2.2', { model: ['T', 'base-memory/aren/model.aren.intgemm.alphas.bin', 31561787, '7b7af0282dc5f4d8805b9a298c2fa828967e3f09ca10f1942ebeea0b2cfc12fa'], lex: ['T', 'base-memory/aren/lex.50.50.aren.s2t.bin', 4627200, '4b45f14dbea40d368093a13563fc1ca48457ee70c1291c82b206f3baff210081'], vocab: ['M', 'aren/vocab.aren.spm', 860035, '51b4ee3f828d10015464523d0b4f5a6c086b0b2a9bde716a581001cf6c260366'] }],
    ['bg', 'Bulgarian', 'Български', '1.0', { model: ['S', 'bgen/model.bgen.intgemm.alphas.bin', 17140899, '71900847a98cf66bd1d05eaafc23a794c8c1285fb3f0e2ecd2849e6f81c79d53'], lex: ['S', 'bgen/lex.50.50.bgen.s2t.bin', 6182512, '71e8d040a2f63705bec232cd186f32e9f9a78e7968216516c4535589f6a828f9'], vocab: ['S', 'bgen/vocab.bgen.spm', 920621, '24ce87ba39216714f222ca6a105f30b1863a7ef8b58c9fafdc7a66184e9813a5'] }],
    ['bn', 'Bengali', 'ব\u09be\u0982ল\u09be', '1.0', { model: ['M', 'bnen/model.bnen.intgemm.alphas.bin', 17141051, '14c1d9e92918e8d04cb0ed351ae386c3b5d5c62a6dc601d9515f4c7e6c2a3a56'], lex: ['M', 'bnen/lex.50.50.bnen.s2t.bin', 4793596, 'aea901a6bd8722962551c0349b8570af684444028b62bbff465be9931e6e9800'], vocab: ['M', 'bnen/vocab.bnen.spm', 981300, '8a6a4de992ccd47bae4227ec6420866374137d6cc88ed6e8b2f16b36322a9d37'] }],
    ['bs', 'Bosnian', 'Bosanski', '2.0', { model: ['T', 'base-memory/bsen/model.bsen.intgemm.alphas.bin', 31561787, '744c61ec0b987c44717f192fcebda7c2a1ac34f5cbfb56672771d28ff79c82c7'], lex: ['T', 'base-memory/bsen/lex.50.50.bsen.s2t.bin', 5155408, 'dccff06320cb87aaa6f93c246038b453d0d0c6f47fa3acd1162f104ac6a2c43f'], vocab: ['T', 'base-memory/bsen/vocab.bsen.spm', 817335, '320561e2cef014a6d626a64822add3a387c91f609f23ea3b7f421d194075c14c'] }],
    ['ca', 'Catalan', 'Català', '1.0', { model: ['T', 'tiny/caen/model.caen.intgemm.alphas.bin', 17140899, '3a315266490d87f72adf9e5387ee567b2fb76a30018e51586b882b1d87bf5aed'], lex: ['T', 'tiny/caen/lex.50.50.caen.s2t.bin', 5244644, 'a648be17d6f008feee687b455d00dbfaedba2ead8bee32658783c4325a8d3ece'], vocab: ['T', 'tiny/caen/vocab.caen.spm', 811443, '10a1f25e5640f596b547190082f87ba4994f8714693904c82a35d965b9cc7470'] }],
    ['cs', 'Czech', 'Čeština', '1.0', { model: ['T', 'tiny/csen/model.csen.intgemm.alphas.bin', 17141051, '4ee5b7906f90ad2407232c077581a247b41ac3886d785be82c5d3657433106ae'], lex: ['T', 'tiny/csen/lex.50.50.csen.s2t.bin', 4839160, '4c302fa188e65ddc55d8191a632e08f66dde7a060cc93df55ef83f0629548385'], vocab: ['T', 'tiny/csen/vocab.csen.spm', 799978, '89c4f6f5cadbc72b25b30079fabf655b897a1bbeaf3eb8adf95d469e10ece265'] }],
    ['da', 'Danish', 'Dansk', '1.0', { model: ['M', 'daen/model.daen.intgemm.alphas.bin', 17141051, '2c1ace24220c905404bbb1de14bfeda8a391ef8d6c56f3b193a9d3e340d99b12'], lex: ['M', 'daen/lex.50.50.daen.s2t.bin', 4489412, 'e5f50fba646e0d3cedf2957575aa84c3bdca6798ce32ccd63c956fc043d774a3'], vocab: ['M', 'daen/vocab.daen.spm', 796018, 'b9392fcd9c53b802628d33a160f6eb52ca3d25a07ec9e015ab93b6bd5c7e8033'] }],
    ['el', 'Greek', 'Ελληνικά', '1.1', { model: ['M', 'elen/model.elen.intgemm.alphas.bin', 17141051, '0a43c3716156061494d995d0c88113e789f8d919e0c88a15bc1ad360e0482a8c'], lex: ['M', 'elen/lex.50.50.elen.s2t.bin', 4295860, '2c969b069b3d230feddd17db2d74eb658a9b33b960d2d40adbca5496c9784e85'], vocab: ['M', 'elen/vocab.elen.spm', 894960, 'e1a1298cc2cf3968f3d7cc3b36bc463a4e1bf154272e8fb2f15142b54edc4349'] }],
    ['et', 'Estonian', 'Eesti', '1.0', { model: ['S', 'eten/model.eten.intgemm.alphas.bin', 17140754, 'aac98a2371e216ee2d4843cbe896c617f6687501e17225ac83482eba52fd0028'], lex: ['S', 'eten/lex.50.50.eten.s2t.bin', 3974944, '6992bedc590e60e610a28129c80746fe5f33144a4520e2c5508d87db14ca54f8'], vocab: ['S', 'eten/vocab.eten.spm', 828426, 'e3b66bc141f6123cd40746e2fb9b8ee4f89cbf324ab27d6bbf3782e52f15fa2d'] }],
    ['fa', 'Persian', 'فارسی', '1.0', { model: ['M', 'faen/model.faen.intgemm.alphas.bin', 17141051, 'aa326306c177e11129de5bfeba518abc499c0b6005492766748a9c9ea6f4c712'], lex: ['M', 'faen/lex.50.50.faen.s2t.bin', 3896420, '4828cb060bd4375f8aabb85fed39c18aca52b738838394546f2ddbf707a6f28e'], vocab: ['M', 'faen/vocab.faen.spm', 843153, 'bf36943053883d6c0fc98c2985f676a0a37042e796bad0e3df0a813d9d5393f4'] }],
    ['fi', 'Finnish', 'Suomi', '2.0', { model: ['M', 'fien/model.fien.intgemm.alphas.bin', 31561787, 'e3887341f18bcc7787d9b59eb1229b56eefce18d49b7ebf1e62c55d65a377321'], lex: ['M', 'fien/lex.50.50.fien.s2t.bin', 5195132, '8bad431e07b062ba47f363b76e4656cc743fd608316d8a4830a4315e44ac9abb'], vocab: ['M', 'fien/vocab.fien.spm', 818770, '6a866911427f2916609ae89c7f2f04a78de3fdd8aa183039ecba986635d4f246'] }],
    ['gu', 'Gujarati', 'ગ\u0ac1જર\u0abeત\u0ac0', '1.0', { model: ['M', 'guen/model.guen.intgemm.alphas.bin', 17141051, '7b16e4e64f2776c73d87db01922c091738566b6a6092a42488cbaee1385cb4ab'], lex: ['M', 'guen/lex.50.50.guen.s2t.bin', 4197836, 'af01dbec5a1555ddad7c4b19878ecda00e6f9d179ca76a40ab2413de6b081cb0'], vocab: ['M', 'guen/vocab.guen.spm', 965143, '6ad2aa442cc04398bd06b4f03a1027939bbfbaac5f87b3d21f667406f4f62704'] }],
    ['he', 'Hebrew', 'עברית', '1.0', { model: ['M', 'heen/model.heen.intgemm.alphas.bin', 17141051, '7291cab3ec483b8cf524da96201fe947dca8c550132be21a06badeb946b5c079'], lex: ['M', 'heen/lex.50.50.heen.s2t.bin', 4636028, '427c88732cb93b28d2a947cace79f62aabceb7d6f4438516e85994b14a73b68e'], vocab: ['M', 'heen/vocab.heen.spm', 845177, '45f5d413b9208c5f24340ab0e20a63604a572784d289baa2d788deea946f79a2'] }],
    ['hi', 'Hindi', 'ह\u093fन\u094dद\u0940', '1.0', { model: ['M', 'hien/model.hien.intgemm.alphas.bin', 17141051, 'c82fd6ed3794b79fb9dde0718a22324502a408a9eca73497b5d0a4b8024ec6de'], lex: ['M', 'hien/lex.50.50.hien.s2t.bin', 4605984, 'e789be33dfdb639e98f5cf9eb01aa945ec3c882f68f3c8860389cf846f0112d8'], vocab: ['M', 'hien/vocab.hien.spm', 925436, '9cbc02094ac2ebd75211b3bb6789a9d6fa112ce3c08e897f1645f18b21fbab00'] }],
    ['hr', 'Croatian', 'Hrvatski', '1.0', { model: ['M', 'hren/model.hren.intgemm.alphas.bin', 17141051, 'fa6c8220d3f1c41eb75b720859971dbe3acb6bf63691656c58faa4cdc28d918d'], lex: ['M', 'hren/lex.50.50.hren.s2t.bin', 3860080, 'c9ef83603e41f78d41fa601ba9c7196be58518bd964bfe364f325665bc8bc7d0'], vocab: ['M', 'hren/vocab.hren.spm', 796159, '4e9cc10e8ff4a4ed64fc90b45835385690e55f49b40e8efe471597d2e3a9cd24'] }],
    ['hu', 'Hungarian', 'Magyar', '1.0', { model: ['M', 'huen/model.huen.intgemm.alphas.bin', 17140899, '518356dbb0c071739318601963a87580fb41732652f52bd3635246330c186d9e'], lex: ['M', 'huen/lex.50.50.huen.s2t.bin', 5162428, 'fff56b2501258ec4c46a8fc715caee7aeb15d853f859cdfacd3ef9903ed2fff1'], vocab: ['M', 'huen/vocab.huen.spm', 820746, '0db772702235b02d1f29abafb7a49ed77e54c60245b3a46e90716e74263aedd6'] }],
    ['id', 'Indonesian', 'Bahasa Indonesia', '1.0', { model: ['M', 'iden/model.iden.intgemm.alphas.bin', 17141051, 'eeed3d8c2c78ec7011b31b2419e1d2dfdf2a7cc0ee0dbb1fcd164c934cb5d328'], lex: ['M', 'iden/lex.50.50.iden.s2t.bin', 4050348, '7a543087d4e9c1fe2f6b6f735b5e31aeadab80235e734c0388278722042ee3a2'], vocab: ['M', 'iden/vocab.iden.spm', 772941, 'a2dd1462abd17cccbbf3fefc562131f06b293f8ff6a5efad73ebb0176810d835'] }],
    ['is', 'Icelandic', 'Íslenska', '2.0', { model: ['M', 'isen/model.isen.intgemm.alphas.bin', 31561787, 'd2c285755d37f710458f1a49db5391a123e4e41ca7bd9829dd87cc61e4907ee6'], lex: ['M', 'isen/lex.50.50.isen.s2t.bin', 3951884, '0655d05ccaf3cd2a01f910ef542455b7b14e66d96f6c95889079b9ca1ee168cf'], vocab: ['M', 'isen/vocab.isen.spm', 808315, '5c69f0c81f6198f5615ac5aad9d89eb81a46ae8ea396a9e8e274a76409d35e13'] }],
    ['kn', 'Kannada', 'ಕನ\u0ccdನಡ', '1.0', { model: ['M', 'knen/model.knen.intgemm.alphas.bin', 17141051, '49e8d3bd794b098047f7b177d9d0e6d3e49ac798c2b75bc132149cb46c5bfbfd'], lex: ['M', 'knen/lex.50.50.knen.s2t.bin', 4655776, 'aa50a74f15e9ef8cf27a5b905c17037bd9d67883afde71b34c4138f9507fedfc'], vocab: ['M', 'knen/vocab.knen.spm', 1065636, 'd729397a42dba5801f330927a9956527161d6e0711b59fcea7cd2e862e6f36cc'] }],
    ['lt', 'Lithuanian', 'Lietuvių', '1.0', { model: ['M', 'lten/model.lten.intgemm.alphas.bin', 17141051, '0aa4571ede6f68db2f14d2662875b4d2e6323aeccd75e3b4377ab9072a22db70'], lex: ['M', 'lten/lex.50.50.lten.s2t.bin', 4724124, 'f687821f4074063031b7857bd61232b4ef520f3cbac5a80d59993b27bf10a032'], vocab: ['M', 'lten/vocab.lten.spm', 807623, 'df3c6b7e9aa74ab4cce9f4ec73a44aac80be05fcd41ae55198a92c07c5ee3109'] }],
    ['lv', 'Latvian', 'Latviešu', '1.0', { model: ['M', 'lven/model.lven.intgemm.alphas.bin', 17141051, '7a96dd363ae9b4485aa254ddbff042223a565a20bfe5ba0ba29b94d8ded0406a'], lex: ['M', 'lven/lex.50.50.lven.s2t.bin', 4214476, 'dff852d317f80169899e2e1132277cf922fa7a117b060e09a14dd19c0e1a02b8'], vocab: ['M', 'lven/vocab.lven.spm', 815278, '585a265757c071f5694d1bb7e65b73f38b1d065a62cda61510fa6c54fb87d2c9'] }],
    ['ml', 'Malayalam', 'മലയ\u0d3eള\u0d02', '1.0', { model: ['M', 'mlen/model.mlen.intgemm.alphas.bin', 17141051, '5480719a5a8ac43acdf28db1c89a4d60837a475e1120ea0c4e021c4d5b7e6fd6'], lex: ['M', 'mlen/lex.50.50.mlen.s2t.bin', 5017972, 'afb882ad10c9540c12fa105e1e5418a54ec8117f11c4f17d998adf1d445e308c'], vocab: ['M', 'mlen/vocab.mlen.spm', 1109047, 'c6b2150c85a18cae437d4e7245ef29d4b3629b2c611fce812d115a59c3b80efe'] }],
    ['ms', 'Malay', 'Bahasa Melayu', '1.0', { model: ['M', 'msen/model.msen.intgemm.alphas.bin', 17141051, 'db5c9415591f8a35c5c72046227b9c9398acade5df8afb5e6ac9f11f7d6650d5'], lex: ['M', 'msen/lex.50.50.msen.s2t.bin', 4371896, '1ef575be54a310eeace84c52e609f2a8c292f3c4b170376ee6ee3524c0c30316'], vocab: ['M', 'msen/vocab.msen.spm', 802191, '6db8c20803d5f9c9fff2b6c3950f5bda4a9fa14aaef1d92818f8a3d53fd850f9'] }],
    ['ro', 'Romanian', 'Română', '1.0', { model: ['M', 'roen/model.roen.intgemm.alphas.bin', 17141051, 'e7542557fc6dbafacddae7b48e67fcdb07bd67b3fb55a76139edf366eca5dbdb'], lex: ['M', 'roen/lex.50.50.roen.s2t.bin', 4691708, 'd242745eadff6f345784fccf1d58046061501b28c8190ba5912a9da5f056cd2f'], vocab: ['M', 'roen/vocab.roen.spm', 800832, '2a690fbcd1b79bc9b99c43d582252720e0900245c82ecc813c8eb05cf063fd0c'] }],
    ['sk', 'Slovak', 'Slovenčina', '1.0', { model: ['M', 'sken/model.sken.intgemm.alphas.bin', 17141051, '1686f94838ace314719e945606a09a66dafd40847dd3fd352ad3f7a969aac62f'], lex: ['M', 'sken/lex.50.50.sken.s2t.bin', 4913324, '18577a7ded6b9957c948f2a384683f7ce09def42336c8141eee7ba86b79e2c8e'], vocab: ['M', 'sken/vocab.sken.spm', 808082, '7d25655bd15f34d77db5d2cb96a51c7943c5528f37f83b677a09bb0ea4e4f59b'] }],
    ['sl', 'Slovenian', 'Slovenščina', '2.1', { model: ['M', 'slen/model.slen.intgemm.alphas.bin', 31561787, '9d15df58b60048366de4f7b6e727157ffdaea3a0fd1c1759ce232b057e2f991c'], lex: ['M', 'slen/lex.50.50.slen.s2t.bin', 4320484, 'f456a49e437ccb4a547e4b51480e29c8b83f11e26a3713af35b078cd4dd255cc'], vocab: ['M', 'slen/vocab.slen.spm', 803078, '54ed331d3435e2bdc5b02462180197b77631f466fc0e61897b5469449857dd2b'] }],
    ['sq', 'Albanian', 'Shqip', '1.0', { model: ['M', 'sqen/model.sqen.intgemm.alphas.bin', 17141051, '4b0ce319e7c8f7e1836ce18cb6522c83268e8cff54f2a7f5dcef270250a44475'], lex: ['M', 'sqen/lex.50.50.sqen.s2t.bin', 4256516, 'b2f51df0bc14b9f89a29d39652a80167ef413eb1579957ecea825cb0a7575c60'], vocab: ['M', 'sqen/vocab.sqen.spm', 820200, '6b7ce057b54ed983eb47087254ea8673e20a857739fc5b57874c80c3301bb91d'] }],
    ['sr', 'Serbian', 'Српски', '1.0', { model: ['M', 'sren/model.sren.intgemm.alphas.bin', 17141051, '99c44e9690a7ed2c1f13468765c3b1db2b8a8ae739980e4056d45dca613a1966'], lex: ['M', 'sren/lex.50.50.sren.s2t.bin', 4628048, '476d9731a1fd44811466abf2292523f11eaad57f0fb7a5cd30391e7720c7071a'], vocab: ['M', 'sren/vocab.sren.spm', 822509, '5cdbad076c8f5b11e3342f5011e9f56f22558523ca82aec9bab621ddc7614bdc'] }],
    ['sv', 'Swedish', 'Svenska', '1.0', { model: ['M', 'sven/model.sven.intgemm.alphas.bin', 17141051, '92d79e2725718b84aed486473bdfcbe6bba3e7094922d4bead8a121cfa346372'], lex: ['M', 'sven/lex.50.50.sven.s2t.bin', 4645680, '1c4640765e806d905cdc4f51158f6f869c78709b9e8a43070877965fa13c160e'], vocab: ['M', 'sven/vocab.sven.spm', 793049, '93427195fac4125722ed778707478ef78cb77b3fdf1ed5b93bee9fd36e30a8ec'] }],
    ['te', 'Telugu', 'త\u0c46ల\u0c41గ\u0c41', '1.0', { model: ['M', 'teen/model.teen.intgemm.alphas.bin', 17141051, 'e2ec7b13ba6148eba309244ee17dc935f1b71e95bbf57154216f6247877abb7e'], lex: ['M', 'teen/lex.50.50.teen.s2t.bin', 4815756, '5df84ca17e4cc76a73ef7d93f94f53a89f37a11a456f2b6373ff19c4ce4ef964'], vocab: ['M', 'teen/vocab.teen.spm', 1056197, 'dd57e1d68316ae32f9ba3f77223f317ce39cd1ef72e69e6b06b7c1d1ba954052'] }],
    ['th', 'Thai', 'ไทย', '2.0', { model: ['T', 'base-memory/then/model.then.intgemm.alphas.bin', 31561787, 'f70a501324743668b031bee19cd001a66839e8e5dfc0b4a1c44d5ea99d4e8d66'], lex: ['T', 'base-memory/then/lex.50.50.then.s2t.bin', 4487056, '3a7661a7f5c811c83f05f53008083b042fea0334fc6044ca1fda4982a8d48453'], vocab: ['T', 'base-memory/then/vocab.then.spm', 995429, 'b625d3dcdfa2b4bbec496c9a0a30d169c917464ac5ea75506c0699972fea95f0'] }],
    ['vi', 'Vietnamese', 'Tiếng Việt', '1.0', { model: ['M', 'vien/model.vien.intgemm.alphas.bin', 17141051, 'de4bf2b9ffb4d910e32720ec3a43655fb6f4062ce5219332f824fc1bdca7a5f4'], lex: ['M', 'vien/lex.50.50.vien.s2t.bin', 3910184, '3a071ed3d982f6eb6ee116b84067bf70041e4229e43ea65ecb6d7c2796e8851b'], vocab: ['M', 'vien/vocab.vien.spm', 757250, 'cb152765d1e71ea3cf96fdb339c764b7201be7b9ab32e20cfebcf16a20fc0939'] }],
  ];
  var LANGS = RAW.map(function (r) {
    var files = {}, size = 0;
    Object.keys(r[4]).forEach(function (k) {
      var f = r[4][k];
      files[k] = { u: BASES[f[0]] + f[1], m: SELF[f[0]] ? SELF[f[0]] + f[1] : '', s: f[2], h: f[3] };
      size += f[2];
    });
    return { code: r[0], name: r[1], native: r[2], version: r[3], files: files, size: size };
  });
  var BY_CODE = {};
  LANGS.forEach(function (L) { BY_CODE[L.code] = L; });
  var ENGINE_SIZE = ENGINE.glue.s + ENGINE.wasm.s;
  // Chrome's Translator API speaks plain BCP 47.
  function chromeCode(c) { return c === 'zh-Hans' ? 'zh' : c; }
  function fromChrome(c) {
    c = String(c || '').toLowerCase();
    if (c === 'zh' || c === 'zh-cn' || c === 'zh-hans') return 'zh-Hans';
    if (c === 'zh-tw' || c === 'zh-hk' || c === 'zh-hant') return 'zh-Hant';
    if (c === 'iw') return 'he';
    if (c === 'no' || c === 'nb') return 'nb';
    return c.split('-')[0];
  }
  var EXTRA_NAMES = { en: 'English', nb: 'Norwegian', be: 'Belarusian', la: 'Latin', ur: 'Urdu', ta: 'Tamil', mr: 'Marathi' };
  function langName(code) { return BY_CODE[code] ? BY_CODE[code].name : EXTRA_NAMES[code] || OTHER_NAME[code] || code; }

  // ---- language names -> codes: ```Spanish, ```español, ```es-ES, ```zh-Hant ----
  // English and native names (any case, accents optional) and language tags.
  // A bare two-letter code that is also a common code-fence language (pl Perl,
  // cs C#, el Emacs Lisp, ml OCaml, sv SystemVerilog) only counts with a region
  // (pl-PL). plugins/translate-blocks keeps a copy of this table for its chips
  // (the tests check that the two agree).
  var ALIASES = {
    es: 'castellano|castilian', pt: 'brazilian portuguese|brazilian|portugues do brasil', nl: 'flemish|vlaams',
    'zh-Hans': 'chinese|simplified chinese|chinese simplified|mandarin|中文|汉语|普通话|简体|简体中文',
    'zh-Hant': 'traditional chinese|chinese traditional|繁體|繁體中文|繁体中文|正體中文',
    ja: 'nihongo', el: 'modern greek', fa: 'farsi|dari', he: 'ivrit', bn: 'bangla', ca: 'valencian', cs: 'cesky',
    id: 'bahasa indonesia|indonesia', ms: 'bahasa melayu|melayu|bahasa malaysia', ro: 'moldovan', sl: 'slovene', hi: 'हिंदी', th: 'ภาษาไทย',
  };
  // Languages people name that have no on-device model (names only: their codes
  // collide with too many code-fence languages, e.g. ps, mk, am).
  var OTHER = {
    en: 'english', nb: 'norwegian|norsk|bokmal|nynorsk', la: 'latin|latina', ur: 'urdu|اردو', ta: 'tamil|தமிழ்', mr: 'marathi|मराठी',
    be: 'belarusian|беларуская', ga: 'irish|gaeilge', cy: 'welsh|cymraeg', eo: 'esperanto', hy: 'armenian|հայերեն', ka: 'georgian|ქართული',
    eu: 'basque|euskara', gl: 'galician|galego', mt: 'maltese|malti', af: 'afrikaans', sw: 'swahili|kiswahili', tl: 'tagalog|filipino',
    pa: 'punjabi|panjabi', ne: 'nepali', si: 'sinhala|sinhalese', km: 'khmer', my: 'burmese', am: 'amharic', mn: 'mongolian',
    kk: 'kazakh', uz: 'uzbek', az: 'azerbaijani|azeri', mk: 'macedonian', yi: 'yiddish', lb: 'luxembourgish', zu: 'zulu', yo: 'yoruba',
    sa: 'sanskrit', grc: 'ancient greek', ku: 'kurdish', ps: 'pashto', so: 'somali', ht: 'haitian creole', mi: 'maori', gd: 'scottish gaelic', fy: 'frisian',
  };
  var AMBIG = { pl: 1, cs: 1, el: 1, ml: 1, sv: 1 };
  function normName(s) {
    s = String(s).toLowerCase();
    try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) {}
    return s.replace(/[\s_()\[\]{}.,:;'"`\/|*!?=+]+/g, ' ').trim();
  }
  var BY_NAME = {}, OTHER_NAME = {};
  LANGS.forEach(function (L) { BY_NAME[normName(L.name)] = L.code; BY_NAME[normName(L.native)] = L.code; });
  Object.keys(ALIASES).forEach(function (c) { ALIASES[c].split('|').forEach(function (n) { BY_NAME[normName(n)] = c; }); });
  Object.keys(OTHER).forEach(function (c) {
    var names = OTHER[c].split('|');
    OTHER_NAME[c] = names[0].replace(/(^|\s)\S/g, function (m) { return m.toUpperCase(); });
    names.forEach(function (n) { if (!BY_NAME[normName(n)]) BY_NAME[normName(n)] = c; });
  });
  // -> code ('es', 'zh-Hant', 'en', 'la' …) or '' when it isn't a language
  function langFromName(info) {
    var raw = String(info || '').trim().replace(/^[{.]+|\}+$/g, '');
    if (!raw || raw.length > 48) return '';
    var n = normName(raw);
    if (!n) return '';
    if (BY_NAME[n]) return BY_NAME[n];
    var parts = raw.split(/[-_]/);
    if (/^[a-z]{2}$/i.test(parts[0]) && parts.every(function (p) { return /^[a-z0-9]{2,8}$/i.test(p); })) {
      var base = parts[0].toLowerCase(), rest = parts.slice(1).join('-').toLowerCase();
      if (base === 'zh') return /(^|-)(hant|tw|hk|mo)(-|$)/.test(rest) ? 'zh-Hant' : 'zh-Hans';
      if (base === 'en') return 'en';
      if (base === 'iw') return 'he';
      if (BY_CODE[base] && (rest || !AMBIG[base])) return base;
      return '';
    }
    var w = normName(raw.split(/[\s,;:(\[{]/)[0]); // "Spanish (Mexico)", "Español text"
    return w && w !== n && BY_NAME[w] ? BY_NAME[w] : '';
  }

  // ---- chunking: keep line structure, translate paragraphs / sentence groups ----
  var SENT = /[^.!?\u3002\uff01\uff1f\u061f\u0964]+(?:[.!?\u3002\uff01\uff1f\u061f\u0964]+["'\u201d\u2019)\]\u00bb]*\s*|$)/g;
  function chunkText(text, max) {
    max = max || 600;
    var lines = String(text).split(/(\r?\n)/), parts = [], texts = [];
    lines.forEach(function (ln) {
      if (/^\r?\n$/.test(ln)) { parts.push(ln); return; }
      var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(ln);
      if (!m[2]) { parts.push(ln); return; }
      if (m[1]) parts.push(m[1]);
      var body = m[2];
      if (body.length <= max) { parts.push({ i: texts.length }); texts.push(body); }
      else {
        var sents = body.match(SENT) || [body], cur = '', cjk = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(body);
        sents.forEach(function (s) {
          if (cur && cur.length + s.length > max) { parts.push({ i: texts.length }); texts.push(cur.trim()); if (!cjk) parts.push(' '); cur = ''; }
          while (s.length > max) { // one huge "sentence": hard split on a space
            var cut = s.lastIndexOf(' ', max); if (cut < max / 2) cut = max;
            parts.push({ i: texts.length }); texts.push(s.slice(0, cut).trim()); if (!cjk) parts.push(' ');
            s = s.slice(cut);
          }
          cur += s;
        });
        if (cur.trim()) { parts.push({ i: texts.length }); texts.push(cur.trim()); }
        else if (parts.length && parts[parts.length - 1] === ' ') parts.pop();
      }
      if (m[3]) parts.push(m[3]);
    });
    return { parts: parts, texts: texts };
  }
  function reassemble(ch, out) {
    return ch.parts.map(function (p) { return typeof p === 'string' ? p : (out[p.i] != null ? out[p.i] : ch.texts[p.i]); }).join('');
  }

  // ---- language guess (no network): scripts, telltale letters, Decode Lab's scorer ----
  var TRAD = '們這個來時為說國會對過後裡麼還從無與學經長發開種現點動樣問關體間見頭話氣產實電當進書車馬門';
  var SIMP = '们这个来时为说国会对过后里么还从无与学经长发开种现点动样问关体间见头话气产实电当进书车马门';
  var MARKS = [
    ['pl', /[ąęłńśźżĄĘŁŃŚŹŻ]/g, 2], ['tr', /[ğışĞİŞ]/g, 2], ['cs', /[ěřůĚŘŮ]/g, 2], ['sk', /[ľĺŕôäĽĹŔ]/g, 1],
    ['ro', /[ăâîșțşţĂÂÎȘȚ]/g, 1], ['hu', /[őűŐŰ]/g, 2], ['vi', /[ạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹđơư]/g, 3],
    ['is', /[þðÞÐ]/g, 3], ['da', /[æøÆØ]/g, 1], ['sv', /[åÅ]/g, 1], ['lt', /[ėįųūĖĮŲŪ]/g, 2], ['lv', /[āēīģķļņĀĒĪĢĶĻŅ]/g, 2],
    ['et', /[õÕ]/g, 1], ['hr', /[ćđĆĐ]/g, 2], ['sq', /[ëË]/g, 1], ['ca', /l·l|[òÒ]/g, 1],
  ];
  function guessLang(text, core) {
    var s = String(text || '').slice(0, 3000), c = {}, k;
    var add = function (key) { c[key] = (c[key] || 0) + 1; };
    for (var i = 0; i < s.length; i++) {
      k = s.charCodeAt(i);
      if (k < 0x370) { if ((k >= 65 && k <= 90) || (k >= 97 && k <= 122) || (k >= 0xc0 && k < 0x250)) add('lat'); }
      else if (k < 0x400) add('el');
      else if (k < 0x530) add('cyr');
      else if (k >= 0x590 && k < 0x600) add('he');
      else if (k >= 0x600 && k < 0x700) add('ar');
      else if (k >= 0x900 && k < 0x980) add('hi');
      else if (k >= 0x980 && k < 0xa00) add('bn');
      else if (k >= 0xa80 && k < 0xb00) add('gu');
      else if (k >= 0xc00 && k < 0xc80) add('te');
      else if (k >= 0xc80 && k < 0xd00) add('kn');
      else if (k >= 0xd00 && k < 0xd80) add('ml');
      else if (k >= 0xe00 && k < 0xe80) add('th');
      else if ((k >= 0x1100 && k < 0x1200) || (k >= 0xac00 && k < 0xd7b0) || (k >= 0x3130 && k < 0x3190)) add('ko');
      else if (k >= 0x3040 && k < 0x3100) add('kana');
      else if ((k >= 0x4e00 && k < 0xa000) || (k >= 0x3400 && k < 0x4dc0)) add('han');
    }
    var top = null, n = 0;
    for (k in c) if (c[k] > n) { n = c[k]; top = k; }
    if (!top || n < 2) return { code: '', conf: 0 };
    var total = 0; for (k in c) total += c[k];
    var purity = n / total;
    if (top === 'han' || top === 'kana') {
      if ((c.kana || 0) > (c.han || 0) * 0.08 || top === 'kana') return { code: 'ja', conf: 0.9 * purity };
      var t = 0, sp = 0;
      for (var j = 0; j < s.length; j++) { if (TRAD.indexOf(s[j]) >= 0) t++; else if (SIMP.indexOf(s[j]) >= 0) sp++; }
      return { code: t > sp ? 'zh-Hant' : 'zh-Hans', conf: 0.85 * purity };
    }
    if (top === 'ar') return { code: /[\u067e\u0686\u0698\u06af\u06a9\u06cc]/.test(s) ? 'fa' : 'ar', conf: 0.85 * purity }; // Persian letters / Farsi kaf + yeh
    if (top === 'cyr') {
      if (/[іїєґІЇЄҐ]/.test(s)) return { code: 'uk', conf: 0.9 * purity };
      if (/[ђћџљњЂЋЏЉЊјЈ]/.test(s)) return { code: 'sr', conf: 0.85 * purity };
      var ru = (s.match(/[ыэёЫЭЁ]/g) || []).length, bg = (s.match(/[ъЪ]/g) || []).length;
      return { code: !ru && bg > 1 ? 'bg' : 'ru', conf: 0.85 * purity };
    }
    if (top !== 'lat') return { code: top, conf: 0.85 * purity };
    // Latin: telltale letters first, then the n-gram/word scorer for the big seven
    var best = null, bn = 0;
    MARKS.forEach(function (mk) { var m = (s.match(mk[1]) || []).length; if (m >= mk[2] && m > bn) { bn = m; best = mk[0]; } });
    var sc = core ? core.score(s) : null;
    var scored = sc && sc.lang && /^(en|es|fr|de|it|pt|nl)$/.test(sc.lang) ? sc : null;
    if (best && (!scored || scored.score < 75 || bn >= 4)) {
      if (best === 'da' && /\b(og|ikke|jeg|det|som)\b/i.test(s) && /\b(ikkje|eg|ein)\b/i.test(s)) best = 'nb';
      return { code: best, conf: Math.min(0.9, 0.45 + bn * 0.08) };
    }
    if (scored) return { code: scored.lang, conf: Math.max(0.3, Math.min(0.97, scored.conf || scored.score / 100)) };
    if (/\b(yang|dan|ini|itu|dengan|untuk)\b/i.test(s)) return { code: 'id', conf: 0.5 };
    return { code: '', conf: 0 };
  }

  // ---- the manager ------------------------------------------------------------
  function create(opts) {
    opts = opts || {};
    var worker = null, seq = 0, pending = {}, chrome = {}, chromeTr = {}, detector = null, cachedSet = null;
    var hasChrome = typeof self !== 'undefined' && typeof self.Translator === 'function';
    var hasDetector = typeof self !== 'undefined' && typeof self.LanguageDetector === 'function';
    var simd = (function () {
      try { return typeof WebAssembly === 'object' && WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch (e) { return false; }
    })();
    var storage = typeof caches !== 'undefined';

    function getWorker() {
      if (worker) return worker;
      if (typeof Worker === 'undefined') throw new Error('Web Workers are unavailable here');
      worker = new Worker(opts.workerUrl);
      worker.onmessage = function (e) {
        var m = e.data || {}, p = pending[m.id];
        if (!p) return;
        if (m.type === 'progress') { if (p.onProgress) p.onProgress(m); return; }
        delete pending[m.id];
        if (m.type === 'error') p.reject(new Error(m.message));
        else p.resolve(m);
      };
      worker.onerror = function (e) {
        if (e && e.preventDefault) e.preventDefault();
        var msg = (e && e.message) || 'translation worker crashed';
        Object.keys(pending).forEach(function (id) { pending[id].reject(new Error(msg)); delete pending[id]; });
        try { worker.terminate(); } catch (x) {}
        worker = null;
      };
      return worker;
    }
    function call(msg, onProgress) {
      return new Promise(function (resolve, reject) {
        var w;
        try { w = getWorker(); } catch (e) { reject(e); return; }
        msg.id = ++seq;
        pending[msg.id] = { resolve: resolve, reject: reject, onProgress: onProgress };
        w.postMessage(msg);
      });
    }
    function filesOf(L) { return Object.keys(L.files).map(function (k) { return L.files[k]; }); }

    // Which registry files are in our bucket (one keys() call, cached until a change).
    function cached() {
      if (cachedSet) return Promise.resolve(cachedSet);
      if (!storage) return Promise.resolve({});
      return caches.open(CACHE).then(function (c) { return c.keys(); }).then(function (keys) {
        var set = {};
        keys.forEach(function (r) { set[r.url] = 1; });
        cachedSet = set;
        return set;
      }, function () { return {}; });
    }
    function invalidate() { cachedSet = null; }
    function hasAll(set, list) { return list.every(function (f) { return set[f.u]; }); }

    function chromeAvail(code) {
      if (!hasChrome) return Promise.resolve('unavailable');
      if (chrome[code]) return Promise.resolve(chrome[code]);
      // availability() itself can hang (seen in headless Chrome): give up after 5 s
      return withTimeout(Promise.resolve().then(function () { return self.Translator.availability({ sourceLanguage: chromeCode(code), targetLanguage: 'en' }); }), 5000, 'availability timeout')
        .then(function (a) { chrome[code] = a || 'unavailable'; return chrome[code]; }, function () { chrome[code] = 'unavailable'; return 'unavailable'; });
    }
    // -> { engine: 'chrome'|'bergamot'|'', ready: bool, needs: 'download'|'chrome-download'|'', size, label, why }
    function status(code) {
      var L = BY_CODE[code];
      return Promise.all([chromeAvail(code), cached()]).then(function (r) {
        var ca = r[0], set = r[1];
        var berg = !!L && simd && storage, bergReady = berg && hasAll(set, filesOf(L)) && hasAll(set, [ENGINE.glue, ENGINE.wasm]);
        var engineMissing = berg && !hasAll(set, [ENGINE.glue, ENGINE.wasm]);
        if (ca === 'available') return { engine: 'chrome', ready: true, label: 'On-device · Chrome' };
        if (bergReady) return { engine: 'bergamot', ready: true, label: 'On-device · Firefox Translations' };
        if (ca === 'downloadable' || ca === 'downloading') return { engine: 'chrome', ready: false, needs: 'chrome-download', label: 'On-device · Chrome', size: 0 };
        if (berg) return { engine: 'bergamot', ready: false, needs: 'download', label: 'On-device · Firefox Translations', size: L.size + (engineMissing ? ENGINE_SIZE : 0) };
        var why = !L ? langName(code) + ' is not available for on-device translation' : !simd ? 'This browser lacks WebAssembly SIMD (needs iOS 16.4+ or a recent Chrome/Firefox)' : 'Cache Storage is unavailable (private browsing?)';
        return { engine: '', ready: false, label: '', why: why };
      });
    }
    function downloaded() {
      return cached().then(function (set) {
        var out = {};
        LANGS.forEach(function (L) { if (hasAll(set, filesOf(L))) out[L.code] = true; });
        out._engine = hasAll(set, [ENGINE.glue, ENGINE.wasm]);
        return out;
      });
    }
    function usage() {
      return cached().then(function (set) {
        var known = {}, total = 0;
        LANGS.forEach(function (L) { filesOf(L).forEach(function (f) { known[f.u] = f.s; }); });
        known[ENGINE.glue.u] = ENGINE.glue.s; known[ENGINE.wasm.u] = ENGINE.wasm.s;
        Object.keys(set).forEach(function (u) { total += known[u] || 0; });
        return total;
      });
    }
    // Download (needs a user tap): Bergamot files into our bucket, or let Chrome fetch its model.
    function download(code, onProgress) {
      return status(code).then(function (st) {
        if (st.ready) return st;
        if (st.engine === 'chrome') {
          return chromeTranslator(code, onProgress).then(function () { chrome[code] = 'available'; return status(code); }, function (e) {
            // Chrome stalled: offer the Firefox Translations download instead.
            if (bergamotPossible(code)) return status(code);
            throw e;
          });
        }
        if (st.engine !== 'bergamot') throw new Error(st.why || 'not available');
        var L = BY_CODE[code], list = [ENGINE.glue, ENGINE.wasm].concat(filesOf(L));
        return call({ type: 'download', files: list }, function (m) { if (onProgress && m.total) onProgress(m.loaded / m.total, m.stage); })
          .then(function () { invalidate(); return status(code); }, function (e) { invalidate(); throw e; });
      });
    }
    function remove(code) {
      var L = BY_CODE[code];
      if (!L || !storage) return Promise.resolve();
      return cached().then(function (set) {
        // a file another downloaded language also uses stays
        var keep = {};
        LANGS.forEach(function (o) { if (o !== L && hasAll(set, filesOf(o))) filesOf(o).forEach(function (f) { keep[f.u] = 1; }); });
        return caches.open(CACHE).then(function (c) {
          return Promise.all(filesOf(L).filter(function (f) { return !keep[f.u]; }).map(function (f) { return c.delete(f.u); }));
        });
      }).then(function () {
        invalidate();
        if (worker) call({ type: 'free' }).catch(function () {});
      });
    }
    function removeAll() {
      freeAll();
      if (!storage) return Promise.resolve();
      return caches.delete(CACHE).then(function () { invalidate(); }, function () { invalidate(); });
    }

    // Chrome's built-in translator can stall (no model fetch ever starts, e.g.
    // in some Chrome builds/headless): a promise that never settles would
    // leave the panel at 0% forever. Watchdogs turn silence into an error, the
    // language is then treated as Chrome-unavailable for this session and
    // Firefox Translations takes over (see translate / download).
    function withTimeout(pr, ms, msg, kick) {
      return new Promise(function (resolve, reject) {
        var t = setTimeout(function () { reject(new Error(msg)); }, ms);
        if (kick) kick(function () { clearTimeout(t); t = setTimeout(function () { reject(new Error(msg)); }, ms); });
        pr.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
      });
    }
    var CHROME_QUIET_MS = 25000;
    function chromeTranslator(code, onProgress) {
      if (chromeTr[code]) return chromeTr[code];
      var bump = null;
      var created = self.Translator.create({
        sourceLanguage: chromeCode(code), targetLanguage: 'en',
        monitor: function (m) {
          m.addEventListener('downloadprogress', function (e) {
            if (bump) bump(); // still downloading: reset the quiet timer
            if (onProgress) onProgress(e.total ? e.loaded / e.total : e.loaded, 'download');
          });
        },
      });
      chromeTr[code] = withTimeout(created, CHROME_QUIET_MS, 'Chrome\u2019s translator didn\u2019t respond', function (reset) { bump = reset; });
      chromeTr[code].catch(function () { delete chromeTr[code]; chrome[code] = 'unavailable'; });
      return chromeTr[code];
    }
    function bergamotPossible(code) { return !!BY_CODE[code] && simd && storage; }

    // translate(text, code, onProgress) -> {text, engine, label, from}
    function translate(text, code, onProgress) {
      return status(code).then(function (st) {
        if (!st.ready) throw new Error(st.why || (langName(code) + ' is not downloaded yet'));
        var ch = chunkText(text, st.engine === 'chrome' ? 1500 : 600), out = new Array(ch.texts.length), done = 0, chars = 0;
        ch.texts.forEach(function (t) { chars += t.length; });
        var tick = function (n) { done += n; if (onProgress) onProgress(chars ? Math.min(1, done / chars) : 1, 'translate'); };
        var finish = function () { return { text: reassemble(ch, out), engine: st.engine, label: st.label, from: code }; };
        if (!ch.texts.length) return finish();
        if (st.engine === 'chrome') {
          return chromeTranslator(code).then(function (tr) {
            var i = 0;
            var next = function () {
              if (i >= ch.texts.length) return finish();
              var k = i++;
              return withTimeout(tr.translate(ch.texts[k]), CHROME_QUIET_MS, 'Chrome\u2019s translator didn\u2019t respond')
                .then(function (r) { out[k] = r; tick(ch.texts[k].length); return next(); });
            };
            return next();
          }).catch(function (e) {
            // Chrome stalled or failed: stop using it for this language and
            // retry on Firefox Translations if its model is already here
            // (otherwise the UI shows its download button via status()).
            chrome[code] = 'unavailable'; delete chromeTr[code];
            if (!bergamotPossible(code)) throw e;
            return status(code).then(function (s2) {
              if (s2.ready && s2.engine === 'bergamot') return translate(text, code, onProgress);
              throw new Error('Chrome\u2019s translator isn\u2019t responding \u2014 download ' + langName(code) + ' for Firefox Translations instead');
            });
          });
        }
        // Bergamot: batches of ~2000 characters so progress keeps moving
        var L = BY_CODE[code], i0 = 0;
        var batch = function () {
          if (i0 >= ch.texts.length) return finish();
          var start = i0, len = 0, list = [];
          while (i0 < ch.texts.length && (list.length === 0 || (len + ch.texts[i0].length <= 2000 && list.length < 16))) { len += ch.texts[i0].length; list.push(ch.texts[i0]); i0++; }
          return call({ type: 'translate', engine: ENGINE, lang: code, files: L.files, texts: list }, function (m) {
            if (onProgress && m.stage !== 'download') onProgress(chars ? done / chars : 0, m.stage);
          }).then(function (m) {
            for (var q = 0; q < list.length; q++) out[start + q] = m.texts[q];
            tick(len);
            return batch();
          });
        };
        return batch();
      });
    }

    // detect(text) -> {code, conf, via}: Chrome's detector when present, else ours
    function detect(text) {
      var ours = guessLang(text, opts.core);
      if (!hasDetector || String(text || '').trim().length < 4) return Promise.resolve({ code: ours.code, conf: ours.conf, via: 'decodelab' });
      return Promise.resolve().then(function () {
        if (!detector) detector = withTimeout(self.LanguageDetector.availability().then(function (a) { return a === 'available' ? self.LanguageDetector.create() : null; }), 4000, 'detector timeout').catch(function () { return null; });
        return detector;
      }).then(function (d) {
        if (!d) return { code: ours.code, conf: ours.conf, via: 'decodelab' };
        return d.detect(String(text).slice(0, 4000)).then(function (r) {
          var top = r && r[0];
          if (!top || top.detectedLanguage === 'und' || top.confidence < 0.4) return { code: ours.code, conf: ours.conf, via: 'decodelab' };
          return { code: fromChrome(top.detectedLanguage), conf: top.confidence, via: 'chrome' };
        });
      }).catch(function () { detector = null; return { code: ours.code, conf: ours.conf, via: 'decodelab' }; });
    }

    function freeAll() {
      Object.keys(chromeTr).forEach(function (k) { chromeTr[k].then(function (t) { try { t.destroy(); } catch (e) {} }, function () {}); });
      chromeTr = {};
      if (worker) { try { worker.terminate(); } catch (e) {} worker = null; }
      Object.keys(pending).forEach(function (id) { pending[id].reject(new Error('cancelled')); delete pending[id]; });
    }

    return {
      languages: function () { return LANGS.slice(); },
      lang: function (c) { return BY_CODE[c] || null; },
      name: langName, fromName: langFromName,
      engineSize: ENGINE_SIZE,
      hasChrome: hasChrome, simd: simd, storage: storage,
      status: status, downloaded: downloaded, usage: usage,
      download: download, remove: remove, removeAll: removeAll,
      translate: translate, detect: detect,
      dispose: freeAll,
    };
  }

  var api = { create: create, chunkText: chunkText, reassemble: reassemble, guessLang: guessLang, langFromName: langFromName, langName: langName, LANGS: LANGS, ENGINE: ENGINE, BASES: BASES, CACHE: CACHE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.__DecodeLabTranslate = api;
})(typeof self !== 'undefined' ? self : this);
