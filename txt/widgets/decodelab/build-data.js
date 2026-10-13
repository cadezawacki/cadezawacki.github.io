#!/usr/bin/env node
/* Decode Lab — builds decodelab-data.js (language statistics) from a folder of
 * plain-text corpora. Dev-only: NOT loaded by the app, not in the manifest.
 *
 *   node txt/widgets/decodelab/build-data.js <corpusDir>
 *
 * <corpusDir> holds files named <lang>-<anything>.txt (UTF-8). The shipped
 * data was derived from PUBLIC-DOMAIN texts only (nothing from them is copied
 * into the repo — only aggregate letter / n-gram / word frequencies):
 *   en  Project Gutenberg #1342 #1661 #2701 #98 #84 #1400 #345 #76 #174 #11
 *       (Austen, Conan Doyle, Melville, Dickens, Shelley, Stoker, Twain, Wilde, Carroll)
 *   es  PG #14944 #17340 #16670 #13264 #17223 #15206 #17406 #13519
 *       (Blasco Ibáñez, Pérez Galdós, Baroja, Valera, Pardo Bazán)
 *   fr  PG #800 #4791 #5711 #5154 #2650 #4968 #5081 (Verne, Zola, Proust)
 *   de  PG #22367 #5323 #2499 #12108 #17622 #6651 #18148 #21989
 *       (Kafka, Fontane, Hesse, Th. Mann, Storm, Schnitzler)
 *   it  PG #52484 #43226 #56775 #45647 #25180 #64062 #58341
 *       (Collodi, Deledda, Pirandello, De Amicis, Salgari)
 *   pt  PG #16384 #18220 #17515 #23145 #33056 #31347 #42942 (Eça de Queirós,
 *       Machado de Assis; 1880s spelling modernised below: ll→l, ph→f, th→t …)
 *   nl  PG #11024 #19563 #17659 #14850 #12003 #13378 #29837 (Multatuli, Couperus, Conscience)
 *   ru  A. P. Chekhov stories (1883–1903, public domain), modern orthography
 *   el  PG #27073 #20175 #27301 #27760 (Chrestomanos, Chatzopoulos, Rhoides)
 * Small hand-made lists for scripts without a corpus (ar, he, hi, zh, ja, ko)
 * are common function words / characters, written for this file.
 */
'use strict';
var fs = require('fs');
var path = require('path');

var dir = process.argv[2];
if (!dir) { console.error('usage: node build-data.js <corpusDir>'); process.exit(1); }
var OUT = path.join(__dirname, 'decodelab-data.js');

var CODE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ'; // alphabet index -> ASCII in the packed n-gram strings
var LANGS = {
  en: { name: 'English', script: 'Latin', ic: 0.0667, quad: true },
  es: { name: 'Spanish', script: 'Latin', ic: 0.0770 },
  fr: { name: 'French', script: 'Latin', ic: 0.0778 },
  de: { name: 'German', script: 'Latin', ic: 0.0762 },
  it: { name: 'Italian', script: 'Latin', ic: 0.0738 },
  pt: { name: 'Portuguese', script: 'Latin', ic: 0.0745 },
  nl: { name: 'Dutch', script: 'Latin', ic: 0.0798 },
  ru: { name: 'Russian', script: 'Cyrillic', ic: 0.0529 },
  el: { name: 'Greek', script: 'Greek', ic: 0.0691 },
};
var ALPHA = {
  Latin: 'abcdefghijklmnopqrstuvwxyz',
  Cyrillic: 'абвгдежзийклмнопрстуфхцчшщъыьэюя',
  Greek: 'αβγδεζηθικλμνξοπρστυφχψω',
};

// Extra words people actually type into puzzles / CTFs that 19th-century
// novels rarely use, so modern plaintext still gets dictionary hits.
var EXTRA = {
  en: 'hello world flag test secret password message key code data file email user please thanks okay ok yes no answer solution puzzle cipher text decode decoded congratulations found hidden treasure meet tonight tomorrow attack dawn north south east west you are this is the quick brown fox jumps over lazy dog',
  es: 'hola mundo secreto mensaje clave gracias si no bandera',
  fr: 'bonjour monde secret message cle merci oui non drapeau',
  de: 'hallo welt geheim nachricht schluessel danke ja nein flagge ist nicht',
  it: 'ciao mondo segreto messaggio chiave grazie si no bandiera',
  pt: 'ola mundo segredo mensagem chave obrigado sim nao bandeira ela ele',
  nl: 'hallo wereld geheim bericht sleutel dank ja nee vlag zo mens een ook niet',
  ru: 'привет мир секрет сообщение ключ спасибо да нет флаг',
  el: 'γεια κοσμος μυστικο μηνυμα κλειδι ευχαριστω ναι οχι',
};

function stripGutenberg(t) {
  var s = t.search(/\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG[^\n]*\n/i);
  if (s >= 0) t = t.slice(t.indexOf('\n', s) + 1);
  var e = t.search(/\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG/i);
  if (e >= 0) t = t.slice(0, e);
  return t;
}
// Dutch 19th-c. spelling: y for ij, zoo, mensch, visch ...
function moderniseNl(t) {
  return t.replace(/y/g, 'ij').replace(/Y/g, 'IJ').replace(/\b([Zz])oo\b/g, '$1o').replace(/([a-z])sch\b/g, '$1s');
}
// Single-letter words that are real words (others are elision debris / initials).
var SINGLE = { en: 'aist', es: 'yaoeu', fr: 'aydlsncjmt', de: '', it: 'eaiold', pt: 'aeo', nl: 'u', ru: 'ивскяоуа', el: 'οη' };
function modernisePt(t) {
  return t.replace(/ph/g, 'f').replace(/th/g, 't').replace(/([^r])\1/g, function (m, c) {
    return /[lmntpbdfgv]/.test(c) ? c : m;
  }).replace(/y/g, 'i').replace(/ahi/g, 'ai').replace(/sahi/g, 'sai');
}

// Same folding the runtime uses (decodelab-core.js letterStream).
function fold(t, script) {
  t = t.toLowerCase();
  if (script === 'Latin') {
    t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/ß/g, 'ss').replace(/æ/g, 'ae').replace(/œ/g, 'oe').replace(/ø/g, 'o').replace(/ł/g, 'l').replace(/ı/g, 'i');
  } else if (script === 'Cyrillic') {
    t = t.replace(/ё/g, 'е');
  } else if (script === 'Greek') {
    t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ς/g, 'σ');
  }
  return t;
}
function indices(folded, alpha) {
  var map = {}; for (var i = 0; i < alpha.length; i++) map[alpha[i]] = i;
  var out = [];
  for (var k = 0; k < folded.length; k++) { var v = map[folded[k]]; if (v !== undefined) out.push(v); }
  return out;
}
function words(t, script) {
  var re = script === 'Latin' ? /[a-z]+/g : script === 'Cyrillic' ? /[а-я]+/g : /[α-ω]+/g;
  return fold(t, script).match(re) || [];
}

function packGrams(counts, n, A, keep, total) {
  var arr = [];
  for (var key in counts) arr.push([+key, counts[key]]);
  arr.sort(function (a, b) { return b[1] - a[1]; });
  var kept = arr.slice(0, keep), cov = 0;
  kept.forEach(function (e) { cov += e[1]; });
  var buckets = {}, hi = 999, lo = 0;
  kept.forEach(function (e) {
    var v = Math.round(-Math.log10(e[1] / total) * 20);
    if (v < hi) hi = v; if (v > lo) lo = v;
    var g = '', k = e[0];
    for (var i = 0; i < n; i++) { g = CODE[k % A] + g; k = Math.floor(k / A); }
    (buckets[v] = buckets[v] || []).push(g);
  });
  var out = [hi];
  for (var v = hi; v <= lo; v++) out.push((buckets[v] || []).join(''));
  return { packed: out, coverage: cov / total, kept: kept.length, distinct: arr.length };
}
function unpack(packed, n, A) {
  var tab = new Uint8Array(Math.pow(A, n)), hi = packed[0], max = 0;
  for (var b = 1; b < packed.length; b++) {
    var s = packed[b], v = hi + b - 1;
    for (var i = 0; i < s.length; i += n) {
      var k = 0; for (var j = 0; j < n; j++) k = k * A + CODE.indexOf(s[i + j]);
      tab[k] = v;
    }
    if (s.length) max = v;
  }
  var floor = Math.min(255, max + 12);
  for (var q = 0; q < tab.length; q++) if (!tab[q]) tab[q] = floor;
  return tab;
}
function avgGram(tab, idx, n, A) {
  var s = 0, c = 0;
  for (var i = 0; i + n <= idx.length; i++) {
    var k = 0; for (var j = 0; j < n; j++) k = k * A + idx[i + j];
    s += tab[k]; c++;
  }
  return c ? s / c : 0;
}

var files = fs.readdirSync(dir).filter(function (f) { return /\.txt$/.test(f); });
var data = { v: 1, langs: {} };
Object.keys(LANGS).forEach(function (code) {
  var L = LANGS[code], alpha = ALPHA[L.script], A = alpha.length;
  var text = files.filter(function (f) { return f.indexOf(code + '-') === 0; }).map(function (f) {
    var t = stripGutenberg(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (code === 'pt') t = modernisePt(t);
    if (code === 'nl') t = moderniseNl(t);
    return t;
  }).join('\n');
  // hold out every 10th 4 KB block for calibration
  var train = '', held = '';
  for (var i = 0, b = 0; i < text.length; i += 4000, b++) {
    if (b % 10 === 9) held += text.slice(i, i + 4000) + '\n'; else train += text.slice(i, i + 4000) + '\n';
  }
  var lower = train.toLowerCase();
  var f = fold(train, L.script), idx = indices(f, alpha);
  // unigrams (folded) and accented letters (unfolded, Latin only)
  var uni = new Array(A).fill(0);
  idx.forEach(function (x) { uni[x]++; });
  var N = idx.length;
  var acc = {};
  if (L.script === 'Latin') {
    var m = lower.match(/[à-öø-ÿœ]/g) || [];
    m.forEach(function (c) { acc[c] = (acc[c] || 0) + 1; });
  } else if (L.script === 'Cyrillic') {
    (lower.match(/ё/g) || []).forEach(function (c) { acc[c] = (acc[c] || 0) + 1; });
  }
  var accStr = Object.keys(acc).filter(function (c) { return acc[c] / N > 0.00005; })
    .sort(function (a, b) { return acc[b] - acc[a]; })
    .map(function (c) { return c + Math.round(acc[c] / N * 100000); }).join(',');
  var ic = 0; uni.forEach(function (c) { ic += c * (c - 1); }); ic /= N * (N - 1);
  // trigrams
  var c3 = {}, c4 = {};
  for (var k = 0; k + 3 <= idx.length; k++) {
    var key = (idx[k] * A + idx[k + 1]) * A + idx[k + 2];
    c3[key] = (c3[key] || 0) + 1;
  }
  var keep3 = code === 'en' ? 4500 : 4000;
  if (L.script === 'Greek') keep3 = 3000;
  if (L.script === 'Cyrillic') keep3 = 6000;
  var p3 = packGrams(c3, 3, A, keep3, idx.length - 2);
  var out = {
    name: L.name, script: L.script, alpha: L.script === 'Latin' ? '' : alpha, ic: L.ic, icCorpus: +ic.toFixed(4),
    uni: uni.map(function (c) { return Math.round(c / N * 100000); }), acc: accStr, t3: p3.packed,
  };
  var tab3 = unpack(p3.packed, 3, A);
  if (L.quad) {
    for (var q = 0; q + 4 <= idx.length; q++) {
      var k4 = ((idx[q] * A + idx[q + 1]) * A + idx[q + 2]) * A + idx[q + 3];
      c4[k4] = (c4[k4] || 0) + 1;
    }
    var p4 = packGrams(c4, 4, A, 12000, idx.length - 3);
    out.t4 = p4.packed;
    console.error(code, 'quadgrams kept', p4.kept, 'of', p4.distinct, 'coverage', p4.coverage.toFixed(3));
  }
  // common words
  // Proper nouns (character names) are capitalised nearly every time: drop them.
  var wc = {}, caps = {};
  var raw = train.match(L.script === 'Latin' ? /[A-Za-z\u00c0-\u024f]+/g : L.script === 'Cyrillic' ? /[\u0400-\u04ff]+/g : /[\u0370-\u03ff\u1f00-\u1fff]+/g) || [];
  raw.forEach(function (w) {
    var fw = fold(w, L.script);
    wc[fw] = (wc[fw] || 0) + 1;
    if (w[0] !== w[0].toLowerCase()) caps[fw] = (caps[fw] || 0) + 1;
  });
  var top = Object.keys(wc).filter(function (w) {
    if ((caps[w] || 0) / wc[w] > 0.6) return false;
    if (w.length === 1 && SINGLE[code].indexOf(w) < 0) return false;
    return true;
  }).sort(function (a, b) { return wc[b] - wc[a]; }).slice(0, 320);
  (EXTRA[code] || '').split(' ').forEach(function (w) { w = fold(w, L.script); if (w && top.indexOf(w) < 0) top.push(w); });
  out.words = top.join(' ');
  // calibration on held-out text: windows of ~120 letters / 25 words
  var hIdx = indices(fold(held, L.script), alpha), sum = 0, cnt = 0, vals = [];
  for (var s = 0; s + 120 <= hIdx.length; s += 120) { var v = avgGram(tab3, hIdx.slice(s, s + 120), 3, A); vals.push(v); sum += v; cnt++; }
  vals.sort(function (a, b) { return a - b; });
  var set = {}; top.forEach(function (w) { set[w] = 1; });
  var hw = words(held, L.script), hits = 0, tot = 0, wl = 0;
  hw.forEach(function (w) { var wt = Math.min(w.length, 6); tot += wt; wl += w.length; if (set[w]) hits += wt; });
  out.exp = { t3: +(sum / cnt).toFixed(2), t3p10: +vals[Math.floor(vals.length * 0.1)].toFixed(2), wh: +(hits / tot).toFixed(3), wl: +(wl / hw.length).toFixed(2) };
  var rs = 0; for (var r = 0; r < tab3.length; r++) rs += tab3[r];
  out.exp.rnd = +(rs / tab3.length).toFixed(2);
  data.langs[code] = out;
  console.error(code, 'letters', N, 'IC', ic.toFixed(4), 'trigrams', p3.kept, '/', p3.distinct, 'cov', p3.coverage.toFixed(3), 'exp', JSON.stringify(out.exp));
});

// Script-level hints for languages without a corpus model: common words
// (space-delimited scripts) or common characters (CJK). Hand-written.
data.scripts = {
  Arabic: { name: 'Arabic', words: 'في من على أن إلى عن مع هذا هذه التي الذي كان ما لا هو هي قد كل بعد ذلك بين أو ثم حتى عند لم إن كانت أيضا يكون لكن الله وقد وهو وفي ومن هناك نحن أنا أنت هم كما لقد عليه فيه منه له لها غير يوم سنة قال' },
  Hebrew: { name: 'Hebrew', words: 'של את על לא זה הוא היא עם כי אני גם מה יש אבל כל או אם היה הם אתה אנחנו לו לי עוד רק כמו אחד אחת שלא מאוד היום אז כך אין בין אחרי לפני הזה הזאת' },
  Devanagari: { name: 'Hindi', words: 'के में की है और से को का एक यह पर हैं भी नहीं था लिए कि जो कर ने तो हो गया कुछ वह इस थे दिया साथ अपने किया जा रहा रही बहुत सकते मैं हम आप' },
  Han: { name: 'Chinese', chars: '的一是不了在人有我他这个们中来上大为和国地到以说时要就出会可也你对生能而子那得于着下自之年过发后作里用道行所然家种事成方多经么去法学如都同现当没动面起看定天分还进好小部其些主样理心她本前开但因只从想实日军者意无力它与长把机十民第公此已工使情明性知全三又关点正业外将两高间由问很最重并物手应战向头文体政美相见被利什二等产或新己制身果加西斯月话合回特代内信表化老给世位次度门任常先海通教儿原东声提立及比员解水名真论处走义各入几口认条平系气题活尔更别打女变四神总何电数安少报才结反受目太量再感建务做接必场件计管期市直德资命山金指克许统区保至队形社便空决治展马科司五基眼书非则听白却界达光放强即像难且权思王象完设式色路记南品住告类求据程北边死张该交规万取拉格望觉术领共确传师观清今切院让识候带导争运笑飞风步改收根干造言联持组每济车亲极林服快办议往元英士证近失转夫令准布始怎呢存未远叫台单影具罗字爱击流备兵连调深商算质团集百需价花党华城石级整府离况亚请技际约示复病息究线似官火断精满支视消越器容照须九增研写称企八功吗包片史委乎查轻易早曾除农找装广显吧阿李标谈吃图念六引历首医局突专费号尽另周较注语仅考落青随选列武红响虽推势参希古众构房半节土投某案黑维革划敌致陈律足态护七兴派孩验责营星够章音跟志底站严巴例防族供效续施留讲型料终答紧黄绝奇察母京段依批群项故按河米围江织害斗双境客纪采举杀攻父苏密低朝友诉止细愿千值仍男钱破网热助倒育属坐帝限船脸职速刻乐否刚威毛状率甚独球般普怕弹校苦创假久错承印晚兰试股拿脑预谁益阳若哪微尼继送急血惊伤素药适波夜省初喜卫源食险待述陆习置居劳财环排福纳欢雷警获模充负云停木游龙树疑层冷洲冲射略范竟句室异激汉村哈策演简卡罪判担州静退既衣您宗积余痛检差富灵协角占配征修皮挥胜降阶审沉坚善妈刘读啊超免压银买皇养伊怀执副乱抗犯追帮宣佛岁航优怪香著田铁控税左右份穿艺背阵草脚概恶块顿敢守酒岛托央户烈洋哥索胡款靠评版宝座释景顾弟登货互付伯慢欧换闻危忙核暗姐介坏讨丽良序升监临亮露永呼味野架域沙掉括舰鱼杂误湾吉减编楚肯测败屋跑梦散温困剑渐封救贵枪缺楼县尚毫移娘朋画班智亦耳恩短掌恐遗固席松秘谢鲁遇康虑幸均销钟诗藏赶剧票损忽巨炮旧端探湖录叶春乡附吸予礼港雨呀板庭妇归睛饭额含顺输摇招婚脱补谓督毒油疗旅泽材灭逐莫笔亡鲜词圣择寻厂睡博勒烟授诺伦岸奥唐卖俄炸载洛健堂旁宫喝借君禁阴园谋宋避抓荣姑孙逃牙束跳顶玉镇雪午练迫爷篇肉嘴馆遍凡础洞卷坦牛宁纸诸训私庄祖丝翻暴森塔默握戏隐熟骨访弱蒙歌店鬼软典欲萨伙遭盘爸扩盖弄雄稳忘亿刺拥徒姆杨齐赛趣曲刀床迎冰虚玩析窗醒妻透购替塞努休虎扬途侵刑绿兄迅套贸毕唯谷轮库迹尤竞街促延震弃甲伟麻川申缓潜闪售灯针哲络抵朱埃抱鼓植纯夏忍页杰筑折郑贝尊吴秀混臣雅振染盛怒舞圆搞狂措姓残秋培迷诚宽宇猛摆梅毁伸摩盟末乃悲拍丁赵硬麦蒋操耶阻订彩抽赞魔纷沿喊违妹浪汇币丰蓝殊献桌啦瓦莱援译夺汽烧距裁偏符勇触课敬哭懂墙袭召罚侠厅拜巧侧韩冒债曼融惯享戴童犹乘挂奖绍厚纵障讯涉彻刊丈爆乌役描洗玛患妙镜唱烦签仙彼弗症仿倾牌陷鸟轰咱菜闭奋庆撤泪茶疾缘播朗杜奶季丹狗尾仪偷奔珠虫驻孔宜艾桥淡翼恨繁寒伴叹旦愈潮粮缩罢聚径恰挑袋灰捕徐珍幕映裂泰隔启尖忠累炎暂估泛荒偿横拒瑞忆孤鼻闹羊呆厉衡胞零穷舍码赫婆魂灾洪腿胆津俗辩胸晓劲贫仁偶辑邦恢赖圈摸仰润堆碰艇稍迟辆废净凶署壁御奉旋冬矿抬蛋晨伏吹鸡倍糊秦盾杯租骑乏隆诊奴摄丧污渡旗甘耐凭扎抢绪粗肩梁幻菲皆碎宙叔岩荡综爬荷悉蒂返井壮薄悄扫敏碍殖详迪矛霍允幅撒剩凯颗骂赏液番箱贴漫酸郎腰舒眉忧浮辛恋餐吓挺励辞艘键伍峰尺昨黎辈贯侦滑券崇扰宪绕趋慈乔阅汗枝拖墨胁插箭腊粉泥氏彭拔骗凤慧媒佩愤扑龄驱惜豪掩兼跃尸肃帕驶堡届欣惠册储飘桑闲惨洁踪勃宾频仇磨递邪撞拟滚奏巡颜剂绩贡疯坡瞧截燃焦殿伪柳锁逼颇昏劝呈搜勤戒驾漂饮曹朵仔柔俩孟腐幼践籍牧凉牲佳娜浓芳稿竹腹跌逻垂遵脉貌柏狱猜怜惑陶兽帐饰贷昌叙躺钢沟寄扶铺邓寿惧询汤盗肥尝匆辉奈扣廷澳嘛董迁凝慰厌脏腾幽怨鞋丢埋泉涌辖躲晋紫艰魏吾慌祝邮吐狠鉴曰械咬邻赤挤弯椅陪割揭韦悟聪雾锋梯猫祥阔誉筹丛牵鸣沈阁穆屈旨袖猎臂蛇贺柱抛鼠瑟戈牢逊迈欺吨琴衰瓶恼燕仲诱狼池疼卢仗冠粒遥吕玄尘冯抚浅敦纠钻晶岂峡苍喷耗凌敲菌赔涂粹扁亏寂煤熊恭湿循暖糖赋抑秩帽哀宿踏烂袁侯抖夹昆肝擦猪炼恒慎搬纽纹玻渔磁铜齿跨押怖漠疲叛遣兹祭醉拳弥斜档稀捷肤疫肿豆削岗晃吞宏癌肚隶履涨耀扭坛拨沃绘伐堪仆郭牺歼墓雇廉契拼惩捉覆刷劫嫌瓜歇雕闷乳串娃缴唤赢莲霸桃妥瘦搭赴岳嘉舱俊址庞耕锐缝悔邀玲惟斥宅添挖呵讼氧浩羽斤酷掠妖祸侍乙妨贪挣汪尿莉悬唇翰仓轨枚盐览傅帅庙芬屏寺胖璃愚滴疏萧姿颤丑劣柯寸扔盯辱匹俱辨饿蜂哦腔郁溃谨糟葛苗肠忌溜鸿爵鹏鹰笼丘桂滋聊挡纲肌茨壳痕碗穴膀卓贤卧膜毅锦欠哩函茫昂薛皱夸豫胃舌剥傲拾窝睁携陵哼棉晴铃填饲渴吻扮逆脆喘罩卜炉柴愉绳胎蓄眠竭喂傻慕浑奸扇柜悦拦诞饱乾泡贼亭夕爹酬儒姻卵氛泄杆挨僧蜜吟猩遂狭肖甜霞驳裕顽於摘矮秒卿畜咽披辅勾盆疆赌塑畏吵囊嗯泊肺骤缠冈羞瞪吊贾漏斑涛悠鹿俘锡卑葬铭滩嫁催璇翅盒蛮矣潘歧赐鲍锅廊拆灌勉盲宰佐啥胀扯禧辽抹筒棋裤唉朴咐孕誓喉妄拘链驰栏逝窃艳臭纤玑棵趁匠盈翁愁瞬婴孝颈倘浙谅蔽畅赠妮莎尉冻跪闯葡後厨鸭颠遮谊圳吁仑辟瘤嫂陀框谭亨钦庸歉芝吼甫衫摊宴嘱衷娇陕矩浦讶耸裸碧摧薪淋耻胶屠鹅饥盼脖虹翠崩账萍逢赚撑翔倡绵猴枯巫昭怔渊凑溪蠢禅阐旺寓藤匪伞碑挪琼脂谎慨菩萄狮掘抄岭晕逮砍挫僵匀睹們這個來時為說國們會對過後裡麼還從無與學經長發開種現點動樣問關體間見頭話氣產們實電當進動' },
  Kana: { name: 'Japanese', chars: 'のにはをたがでてとしれさるいかもなすっうりんこまくあよだけおきつせえそらわめろやほみねひへゆふむちぬょゃゅァアィイゥウェエォオカガキギクグケゲコゴサザシジスズセゼソゾタダチヂッツヅテデトドナニヌネノハバパヒビピフブプヘベペホボポマミムメモャヤュユョヨラリルレロワヲンー日本人年一大国会中出事時見行上生分自者前' },
  Hangul: { name: 'Korean', chars: '이의는을에가다하고지한기로서사대를도리인나있어수시것보자일라아스여게요니해우그면되상들정과만전부주으오계성장제화동문구국공내위소비거마히중무유모개원신관세조미연학방드때현물생실경저말결적했던었습니까합니다않았지만라고에서' },
};

var json = JSON.stringify(data);
var src = '/* Decode Lab language statistics — GENERATED by build-data.js from public-domain\n' +
  ' * texts (see the source list there); do not edit by hand. Letter / n-gram data are\n' +
  ' * aggregate frequencies only. n-gram strings use alphabet indices a=0 … z=25, A=26 …;\n' +
  ' * t3/t4 = [firstLevel, bucket…], each bucket a run of n-grams whose -log10 p * 20 = level. */\n' +
  '(function (root) {\n  var D = ' + json + ';\n' +
  '  if (typeof module !== \'undefined\' && module.exports) module.exports = D; else root.__decodeLabData = D;\n' +
  '})(typeof self !== \'undefined\' ? self : this);\n';
fs.writeFileSync(OUT, src);
console.error('wrote', OUT, (Buffer.byteLength(src) / 1024).toFixed(1) + ' KB');
