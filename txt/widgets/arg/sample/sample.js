/* ============================================================
   ARG Desk — SAMPLE GAME ("The Meridian Ledger")
   ------------------------------------------------------------
   Placeholder content for exploring the desk. It loads into its own
   game slot ("Open the sample game") and never touches your real game.
   The "record" anchors are real and checkable; the game itself, its
   fictional characters and its puzzles are invented.
   Shape: chapters → events → puzzles, plus clues, characters, places,
   timeline entries, assets, research, ideas, questions, tasks, notes.
   ============================================================ */
window.ARG_SAMPLE = {
 "game": {
  "title": "The Meridian Ledger",
  "codename": "MERIDIAN",
  "tagline": "Some unexplained events were not accidents. Someone kept a list.",
  "premise": "In 1912, the year Wilfrid Voynich bought his manuscript, a junior cataloguer named Ida Vance began a private ledger of \"corrections\": moments where a quiet society of mapmakers, the Concordance of the Meridian, edited the historical record. Today an archivist has found the ledger at an estate sale with most of its pages missing. Players reassemble it, one real mystery at a time.",
  "format": "Published all at once and left in the wild. Small private group of players. Hints are rare.",
  "players": "A small private group (5–8 friends)",
  "today": "2026-10-07",
  "id": "sample"
 },
 "chapters": [
  {
   "id": "CH0",
   "n": 0,
   "title": "The Classified",
   "summary": "Trailhead. A strange classified ad leads to an archivist's blog and one photographed ledger page."
  },
  {
   "id": "CH1",
   "n": 1,
   "title": "Folio One",
   "summary": "The first full folio. Players learn the ledger has an author and that its dates are deliberate."
  },
  {
   "id": "CH2",
   "n": 2,
   "title": "The Ledger",
   "summary": "Entries for the sea, the sky and the Shepherd's Monument. The Concordance becomes visible."
  },
  {
   "id": "CH3",
   "n": 3,
   "title": "The Meridian",
   "summary": "The phantom centuries. Every entry lines up on one meridian. The finale."
  }
 ],
 "events": [
  {
   "id": "E01",
   "title": "Tamám Shud",
   "chapter": "CH0",
   "order": 1,
   "layer": "pseudo",
   "when": "1948",
   "place": "pl-somerton",
   "record": "A man was found dead on Somerton Park beach, Adelaide, on 1 Dec 1948. A scrap reading \"Tamám Shud\" had been torn from a copy of the Rubáiyát, and a pencilled code in that copy is still unexplained. Researchers named him as Carl \"Charles\" Webb in 2022.",
   "twist": "The pencilled code is a ledger entry in someone else's hand. Our trailhead quotes its first line.",
   "research": [
    "R01",
    "R02"
   ],
   "puzzles": [
    "P01"
   ],
   "notes": ""
  },
  {
   "id": "E02",
   "title": "The Estate Sale",
   "chapter": "CH0",
   "order": 2,
   "layer": "fiction",
   "when": "2026-09-26",
   "place": null,
   "record": "",
   "twist": "Mira Okafor buys a ledger at an estate sale and posts one photographed page. The photo is the trail's first real lead.",
   "research": [],
   "puzzles": [
    "P02"
   ],
   "notes": ""
  },
  {
   "id": "E03",
   "title": "The Dancing Plague of 1518",
   "chapter": "CH1",
   "order": 1,
   "layer": "record",
   "when": "1518",
   "place": "pl-strasbourg",
   "record": "In July 1518 dozens of people in Strasbourg danced for days. Chronicles name Frau Troffea as the first. Mass psychogenic illness is the leading explanation.",
   "twist": "Ledger entry I. Ida writes it as \"the first correction\".",
   "research": [
    "R03",
    "R04"
   ],
   "puzzles": [
    "P03"
   ],
   "notes": ""
  },
  {
   "id": "E04",
   "title": "1908, Twice: Tunguska and the Phaistos Disc",
   "chapter": "CH1",
   "order": 2,
   "layer": "record",
   "when": "1908-06-30",
   "place": "pl-tunguska",
   "record": "Two finds three days apart. On 30 June 1908 an airburst over Siberia flattened about 80 million trees across roughly 2,000 km² of forest. No impact crater was found. A fired-clay disc stamped with 45 distinct signs, found by Luigi Pernier at the Minoan palace of Phaistos, Crete, in 1908. Undeciphered. A few scholars question its authenticity.",
   "twist": "The three-day gap between the two 1908 dates is the key to Folio One: read in spiral order and shifted by three, the disc's signs give a bearing.",
   "research": [
    "R05",
    "R06",
    "R07"
   ],
   "puzzles": [
    "P04"
   ],
   "notes": ""
  },
  {
   "id": "E05",
   "title": "Croatoan",
   "chapter": "CH1",
   "order": 3,
   "layer": "record",
   "when": "1590",
   "place": "pl-roanoke",
   "record": "Colony founded 1587. When John White returned in August 1590 the settlers were gone; \"CROATOAN\" was carved on a post and \"CRO\" on a tree.",
   "twist": "The carved post is a marker, one of many. Players pick the right one with a bearing.",
   "research": [
    "R08"
   ],
   "puzzles": [
    "P05"
   ],
   "notes": ""
  },
  {
   "id": "E06",
   "title": "Folio Three",
   "chapter": "CH1",
   "order": 4,
   "layer": "fiction",
   "when": "",
   "place": null,
   "record": "",
   "twist": "A printed folio waits inside a copy of the Rubáiyát, closing the loop with the trailhead.",
   "research": [
    "R01"
   ],
   "puzzles": [
    "P06"
   ],
   "notes": "Placement depends on Q03."
  },
  {
   "id": "E07",
   "title": "The Wow! signal",
   "chapter": "CH2",
   "order": 1,
   "layer": "record",
   "when": "1977",
   "place": "pl-bigear",
   "record": "On 15 Aug 1977 Ohio State's Big Ear telescope recorded a 72-second narrowband signal. Jerry Ehman circled \"6EQUJ5\" on the printout and wrote \"Wow!\".",
   "twist": "A 72-second audio file hides 6EQUJ5 in its spectrogram; Big Ear's intensity code turns it into numbers.",
   "research": [
    "R11"
   ],
   "puzzles": [
    "P07"
   ],
   "notes": ""
  },
  {
   "id": "E08",
   "title": "The Mary Celeste",
   "chapter": "CH2",
   "order": 2,
   "layer": "record",
   "when": "1872",
   "place": "pl-azores",
   "record": "Found adrift and seaworthy near the Azores on 4 Dec 1872 by the Dei Gratia. Crew and passengers were never found. Conan Doyle's 1884 story popularised the misspelling \"Marie Celeste\".",
   "twist": "Ida spells it \"Marie\". The misspelling tells players which text keys the book cipher.",
   "research": [
    "R09",
    "R10"
   ],
   "puzzles": [
    "P08"
   ],
   "notes": ""
  },
  {
   "id": "E09",
   "title": "The Shepherd's Monument",
   "chapter": "CH2",
   "order": 3,
   "layer": "pseudo",
   "when": "1750",
   "place": "pl-shugborough",
   "record": "The Shepherd's Monument at Shugborough Hall, Staffordshire (18th c.), carries the letters O U O S V A V V between D and M. No accepted solution; many fringe readings.",
   "twist": "Scratched on the ledger's spine since the trailhead photo. It is a key, not a message.",
   "research": [
    "R12"
   ],
   "puzzles": [
    "P09"
   ],
   "notes": ""
  },
  {
   "id": "E10",
   "title": "The Missing Quire (Voynich manuscript)",
   "chapter": "CH2",
   "order": 4,
   "layer": "record",
   "when": "1404",
   "place": "pl-beinecke",
   "record": "Vellum radiocarbon-dated to 1404–1438. Bought by Wilfrid Voynich in 1912; now Beinecke Library MS 408 at Yale. The text is undeciphered and the foliation shows missing leaves.",
   "twist": "Ida claims she held one of the missing leaves during the 1912 purchase.",
   "research": [
    "R13"
   ],
   "puzzles": [
    "P10"
   ],
   "notes": ""
  },
  {
   "id": "E11",
   "title": "The Phantom Centuries",
   "chapter": "CH3",
   "order": 1,
   "layer": "pseudo",
   "when": "1991",
   "place": null,
   "record": "Heribert Illig's 1991 claim that the years 614–911 AD were fabricated. Rejected by historians; contradicted by astronomy and tree-ring dating.",
   "twist": "The Concordance did not add 297 years. They removed events, and the ledger lists what was removed.",
   "research": [
    "R14",
    "R15"
   ],
   "puzzles": [
    "P11"
   ],
   "notes": ""
  },
  {
   "id": "E12",
   "title": "Dyatlov Pass",
   "chapter": "CH3",
   "order": 2,
   "layer": "pseudo",
   "when": "1959",
   "place": "pl-dyatlov",
   "record": "Nine hikers died in the northern Urals on the night of 1–2 Feb 1959. A 2020 Russian review and a 2021 study point to a slab avalanche; other theories persist.",
   "twist": "The 1959 entry is in a different hand. Ida vanished in 1937, so who wrote it?",
   "research": [
    "R16",
    "R17"
   ],
   "puzzles": [
    "P12"
   ],
   "notes": ""
  },
  {
   "id": "E13",
   "title": "The Meridian",
   "chapter": "CH3",
   "order": 3,
   "layer": "fiction",
   "when": "",
   "place": null,
   "record": "",
   "twist": "Finale. The reassembled ledger lines up on one meridian and names who has been keeping it.",
   "research": [],
   "puzzles": [
    "P13"
   ],
   "notes": ""
  },
  {
   "id": "E14",
   "title": "The Piri Reis map",
   "chapter": null,
   "order": 1,
   "layer": "pseudo",
   "when": "1513",
   "place": null,
   "record": "Ottoman admiral Piri Reis drew a world map in 1513; it was rediscovered in 1929. Hapgood (1966) claimed it shows ice-free Antarctica; cartographers reject this.",
   "twist": "Parking lot. Possible Chapter 3 overlay puzzle.",
   "research": [
    "R18"
   ],
   "puzzles": [],
   "notes": ""
  }
 ],
 "puzzles": [
  {
   "id": "P01",
   "title": "The Classified",
   "chapter": "CH0",
   "event": "E01",
   "kind": "research",
   "difficulty": 2,
   "status": "tested",
   "estMin": 40,
   "premise": "A classified ad: TAMÁM SHUD — LEDGER FOUND — WHO KEEPS THE REST? Reply to Box 72. Below it, the first line of the real Somerton code.",
   "mechanic": "Players connect \"Tamám Shud\" to the 1948 Somerton case and to FitzGerald's Rubáiyát, then read the box number as a quatrain number.",
   "solution": "Box 72 → FitzGerald quatrain LXXII (1st ed.) → the initials of its four lines are the password to mira-okafor.blog/ledger.",
   "solvePath": [
    "Search \"Tamám Shud\" and find the Somerton Man case.",
    "Learn the scrap was torn from the Rubáiyát.",
    "Read \"Box 72\" as quatrain 72 of FitzGerald's first edition.",
    "Take the initials of its four lines as the blog password."
   ],
   "aha": "The box number is a quatrain number.",
   "hints": [],
   "checks": [
    "single",
    "verifiable",
    "contained",
    "phone",
    "people"
   ],
   "requires": [],
   "inputs": [
    "C01",
    "C02"
   ],
   "reveals": [
    "c-mira",
    "TL16"
   ],
   "assets": [
    "AS01"
   ],
   "notes": "Tested with two friends: both solved it in about 35 minutes."
  },
  {
   "id": "P02",
   "title": "Estate Sale",
   "chapter": "CH0",
   "event": "E02",
   "kind": "stego",
   "difficulty": 3,
   "status": "tested",
   "estMin": 60,
   "premise": "Mira's blog post shows a photo of one ledger page with a long caption about the estate sale.",
   "mechanic": "The image file's metadata holds a GPS position.",
   "solution": "EXIF GPS 48.5818 N, 7.7509 E → Strasbourg Cathedral → ledger entry \"Strasbourg 14.7.1518\".",
   "solvePath": [
    "Download the photo from the blog.",
    "Read its metadata; the GPS fields are set.",
    "Map the coordinates: Strasbourg Cathedral.",
    "Match it to the dated entry visible in the photo."
   ],
   "aha": "The photo carries more than pixels.",
   "hints": [
    "Mira's caption says she \"didn't touch the file\". Make that the only hint."
   ],
   "checks": [
    "single",
    "verifiable",
    "contained",
    "people"
   ],
   "requires": [
    "P01"
   ],
   "inputs": [
    "C03",
    "C04"
   ],
   "reveals": [
    "TL04",
    "TL23"
   ],
   "assets": [
    "AS02",
    "AS03"
   ],
   "notes": "Phone check failed: iOS strips location when saving images from the browser. Offer a direct file link."
  },
  {
   "id": "P03",
   "title": "St. Vitus' Dance",
   "chapter": "CH1",
   "event": "E03",
   "kind": "cipher",
   "difficulty": 3,
   "status": "built",
   "estMin": 50,
   "premise": "Folio One carries a paragraph of nonsense letters under the Strasbourg entry.",
   "mechanic": "Vigenère-enciphered paragraph. The key is the name of the first dancer in the chronicles.",
   "solution": "Key TROFFEA → \"THE FIRST CORRECTION WAS MADE AT STRASBOURG. I.V.\"",
   "solvePath": [
    "Notice the letter frequencies look flat (not a simple shift).",
    "Find who danced first in July 1518: Frau Troffea.",
    "Decrypt with Vigenère, key TROFFEA."
   ],
   "aha": "The ledger names the key in its own entry.",
   "hints": [],
   "checks": [
    "single",
    "verifiable",
    "contained"
   ],
   "recipe": {
    "plaintext": "THE FIRST CORRECTION WAS MADE AT STRASBOURG. I.V.",
    "steps": [
     {
      "op": "vigenere",
      "key": "TROFFEA"
     }
    ],
    "output": "MYS KNVSM TCWWICMZCS BES FRRJ FX SMIOXGSUKX. W.A."
   },
   "requires": [
    "P02"
   ],
   "inputs": [
    "C05",
    "C06"
   ],
   "reveals": [
    "c-ida"
   ],
   "assets": [
    "AS05"
   ]
  },
  {
   "id": "P04",
   "title": "1908, Twice",
   "chapter": "CH1",
   "event": "E04",
   "kind": "logic",
   "difficulty": 4,
   "status": "built",
   "estMin": 75,
   "premise": "Two newspaper clippings from 1908 and a sheet of 45 glyph cards copied from the Phaistos Disc.",
   "mechanic": "Tunguska (30 Jun 1908) and the Phaistos Disc find (3 Jul 1908) are three days apart. Glyph cards read in spiral order and shifted by three give a compass bearing.",
   "solution": "Bearing 287° from Strasbourg.",
   "solvePath": [
    "Date both clippings: 30 June and 3 July 1908.",
    "Count the gap: three days.",
    "Order the glyph cards as they spiral on the disc, rim inward.",
    "Shift each glyph's index by three to read digits 2-8-7."
   ],
   "aha": "Two things surfaced in 1908, three days apart.",
   "hints": [],
   "checks": [
    "contained",
    "phone"
   ],
   "requires": [
    "P02"
   ],
   "inputs": [
    "C07",
    "C08"
   ],
   "reveals": [
    "TL11",
    "TL12"
   ],
   "assets": [
    "AS05",
    "AS10"
   ],
   "notes": "Friend test: 1 of 4 solved it. Everyone read the spiral outside-in; either make that the answer or add an arrow glyph. Confirm the 3 July date first (Q02)."
  },
  {
   "id": "P05",
   "title": "Croatoan",
   "chapter": "CH1",
   "event": "E05",
   "kind": "geo",
   "difficulty": 3,
   "status": "draft",
   "estMin": 45,
   "premise": "The Cartographer posts six photos of carved wooden posts.",
   "mechanic": "The bearing from P04 and the letters CRO pick out one post among six.",
   "solution": "Post 4 → carved date 18.8.1590.",
   "solvePath": [
    "Lay the six photos out by the compass direction in each.",
    "Take bearing 287° from Strasbourg.",
    "Only post 4 faces that way and shows CRO."
   ],
   "aha": "The bearing tells you which way the post faces.",
   "hints": [],
   "checks": [],
   "requires": [
    "P03",
    "P04"
   ],
   "inputs": [
    "C09",
    "C10"
   ],
   "reveals": [
    "TL06"
   ],
   "assets": [
    "AS11"
   ],
   "notes": "Shoot on prop posts. Never carve anything real."
  },
  {
   "id": "P06",
   "title": "Folio Three",
   "chapter": "CH1",
   "event": "E06",
   "kind": "physical",
   "difficulty": 2,
   "status": "idea",
   "estMin": 30,
   "premise": "A printed ledger folio tucked inside a copy of the Rubáiyát.",
   "mechanic": "Players who own the trail's earlier answers know which shelf and which copy.",
   "solution": "TBD.",
   "solvePath": [],
   "aha": "",
   "hints": [],
   "checks": [],
   "requires": [
    "P05"
   ],
   "inputs": [
    "C11"
   ],
   "reveals": [],
   "assets": [
    "AS08"
   ],
   "notes": "Blocked on Q03: library permission vs. our own copy in a friendly bookshop."
  },
  {
   "id": "P07",
   "title": "Six Equals",
   "chapter": "CH2",
   "event": "E07",
   "kind": "audio",
   "difficulty": 4,
   "status": "draft",
   "estMin": 60,
   "premise": "A 72-second audio file of hiss and a faint tone.",
   "mechanic": "Its spectrogram shows 6EQUJ5. Big Ear's intensity code (0–9, then A=10) turns it into numbers that index into Folio Three.",
   "solution": "6, 14, 26, 30, 19, 5 → letters from Folio Three → CELESTE.",
   "solvePath": [
    "Open the audio in a spectrogram viewer.",
    "Read 6EQUJ5 in the image.",
    "Recognise the Wow! signal printout.",
    "Convert with Big Ear's code (A=10): 6 14 26 30 19 5.",
    "Index those positions into Folio Three."
   ],
   "aha": "Look at the sound instead of listening to it.",
   "hints": [],
   "checks": [
    "verifiable"
   ],
   "recipe": {
    "plaintext": "6EQUJ5",
    "steps": [
     {
      "op": "bigear"
     }
    ],
    "output": "6 14 26 30 19 5"
   },
   "requires": [
    "P06"
   ],
   "inputs": [
    "C12",
    "C13"
   ],
   "reveals": [
    "TL20"
   ],
   "assets": [
    "AS07"
   ]
  },
  {
   "id": "P08",
   "title": "Dei Gratia",
   "chapter": "CH2",
   "event": "E08",
   "kind": "cipher",
   "difficulty": 3,
   "status": "draft",
   "estMin": 50,
   "premise": "Number groups in Ida's hand, under an entry that spells the ship \"Marie Celeste\".",
   "mechanic": "Book cipher keyed to Conan Doyle's 1884 story, the one that popularised the misspelling.",
   "solution": "page.line.word triples → \"THE CREW WERE NEVER MISSING\".",
   "solvePath": [
    "Notice the misspelling \"Marie\".",
    "Trace it to Doyle's 1884 story.",
    "Read the number groups as page.line.word in the Cornhill printing."
   ],
   "aha": "Ida misspells the ship on purpose.",
   "hints": [],
   "checks": [],
   "requires": [
    "P06"
   ],
   "inputs": [
    "C15",
    "C16"
   ],
   "reveals": [
    "TL08",
    "TL09"
   ],
   "assets": [
    "AS05"
   ]
  },
  {
   "id": "P09",
   "title": "Shepherd's Letters",
   "chapter": "CH2",
   "event": "E09",
   "kind": "cipher",
   "difficulty": 5,
   "status": "idea",
   "estMin": 90,
   "premise": "OUOSVAVV, scratched on the ledger spine since the trailhead photo.",
   "mechanic": "The eight letters are a key, not a message. Combine them with CELESTE.",
   "solution": "TBD.",
   "solvePath": [],
   "aha": "The spine has been in plain sight since the first photo.",
   "hints": [],
   "checks": [],
   "requires": [
    "P07",
    "P08"
   ],
   "inputs": [
    "C14"
   ],
   "reveals": [],
   "assets": [
    "AS03"
   ]
  },
  {
   "id": "P10",
   "title": "The Missing Quire",
   "chapter": "CH2",
   "event": "E10",
   "kind": "research",
   "difficulty": 4,
   "status": "idea",
   "estMin": 80,
   "premise": "Ida's catalogue card describing a leaf \"removed for safekeeping\".",
   "mechanic": "Players compare her description with the Beinecke facsimile to find which leaf is missing.",
   "solution": "TBD.",
   "solvePath": [],
   "aha": "",
   "hints": [],
   "checks": [],
   "requires": [
    "P09"
   ],
   "inputs": [
    "C18"
   ],
   "reveals": [
    "TL14"
   ],
   "assets": []
  },
  {
   "id": "P11",
   "title": "Phantom Centuries",
   "chapter": "CH3",
   "event": "E11",
   "kind": "logic",
   "difficulty": 5,
   "status": "idea",
   "estMin": 90,
   "premise": "Every ledger date collected so far.",
   "mechanic": "Shift every ledger date back 297 years, the span of Illig's phantom time. The shifted dates line up on one meridian.",
   "solution": "TBD.",
   "solvePath": [],
   "aha": "The missing centuries are a number, not a gap.",
   "hints": [],
   "checks": [],
   "requires": [
    "P10"
   ],
   "inputs": [
    "C19"
   ],
   "reveals": [
    "TL21"
   ],
   "assets": []
  },
  {
   "id": "P12",
   "title": "Dyatlov Bearing",
   "chapter": "CH3",
   "event": "E12",
   "kind": "geo",
   "difficulty": 4,
   "status": "idea",
   "estMin": 60,
   "premise": "The 1959 entry, in a different hand, gives a bearing from the pass.",
   "mechanic": "Three bearings, from Strasbourg, Tunguska and Dyatlov Pass, cross at one point.",
   "solution": "TBD.",
   "solvePath": [],
   "aha": "",
   "hints": [],
   "checks": [],
   "requires": [
    "P08"
   ],
   "inputs": [
    "C10",
    "C20"
   ],
   "reveals": [
    "TL18",
    "TL17"
   ],
   "assets": []
  },
  {
   "id": "P13",
   "title": "The Meridian",
   "chapter": "CH3",
   "event": "E13",
   "kind": "meta",
   "difficulty": 5,
   "status": "idea",
   "estMin": 120,
   "premise": "The reassembled ledger.",
   "mechanic": "Finale. Each ledger entry gives one letter; the meridian line puts them in order.",
   "solution": "TBD.",
   "solvePath": [],
   "aha": "",
   "hints": [],
   "checks": [],
   "final": true,
   "requires": [
    "P11",
    "P12"
   ],
   "inputs": [],
   "reveals": [],
   "assets": [
    "AS09"
   ]
  }
 ],
 "clues": [
  {
   "id": "C01",
   "text": "TAMÁM SHUD — LEDGER FOUND — WHO KEEPS THE REST?",
   "kind": "text",
   "plantedIn": "AS01",
   "usedBy": [
    "P01"
   ],
   "layer": "fiction"
  },
  {
   "id": "C02",
   "text": "Reply to Box 72",
   "kind": "text",
   "plantedIn": "AS01",
   "usedBy": [
    "P01"
   ],
   "layer": "fiction"
  },
  {
   "id": "C03",
   "text": "Photo of one ledger page on Mira's blog",
   "kind": "image",
   "plantedIn": "AS03",
   "usedBy": [
    "P02"
   ],
   "layer": "fiction"
  },
  {
   "id": "C04",
   "text": "EXIF GPS 48.5818 N, 7.7509 E",
   "kind": "data",
   "plantedIn": "AS03",
   "usedBy": [
    "P02"
   ],
   "layer": "fiction"
  },
  {
   "id": "C05",
   "text": "Folio One ciphertext paragraph",
   "kind": "text",
   "plantedIn": "AS05",
   "usedBy": [
    "P03"
   ],
   "layer": "fiction"
  },
  {
   "id": "C06",
   "text": "\"Frau Troffea\" named in the Strasbourg entry",
   "kind": "text",
   "plantedIn": "AS05",
   "usedBy": [
    "P03"
   ],
   "layer": "record"
  },
  {
   "id": "C07",
   "text": "Phaistos glyph cards (45 signs)",
   "kind": "image",
   "plantedIn": "AS10",
   "usedBy": [
    "P04"
   ],
   "layer": "record"
  },
  {
   "id": "C08",
   "text": "Two newspaper clippings dated 1908",
   "kind": "image",
   "plantedIn": "AS05",
   "usedBy": [
    "P04"
   ],
   "layer": "record"
  },
  {
   "id": "C09",
   "text": "Photo series: six carved posts",
   "kind": "image",
   "plantedIn": "AS11",
   "usedBy": [
    "P05"
   ],
   "layer": "fiction"
  },
  {
   "id": "C10",
   "text": "Bearing 287° from Strasbourg",
   "kind": "derived",
   "plantedIn": "P04",
   "usedBy": [
    "P05",
    "P12"
   ],
   "layer": "fiction"
  },
  {
   "id": "C11",
   "text": "Printed Folio Three insert",
   "kind": "object",
   "plantedIn": "AS08",
   "usedBy": [
    "P06"
   ],
   "layer": "fiction"
  },
  {
   "id": "C12",
   "text": "bigear_72s.wav",
   "kind": "audio",
   "plantedIn": "AS07",
   "usedBy": [
    "P07"
   ],
   "layer": "fiction"
  },
  {
   "id": "C13",
   "text": "Folio Three text",
   "kind": "text",
   "plantedIn": "AS08",
   "usedBy": [
    "P07"
   ],
   "layer": "fiction"
  },
  {
   "id": "C14",
   "text": "OUOSVAVV scratched on the ledger spine",
   "kind": "image",
   "plantedIn": "AS03",
   "usedBy": [
    "P09"
   ],
   "layer": "record"
  },
  {
   "id": "C15",
   "text": "Number groups in Ida's hand",
   "kind": "text",
   "plantedIn": "AS05",
   "usedBy": [
    "P08"
   ],
   "layer": "fiction"
  },
  {
   "id": "C16",
   "text": "Ida spells it \"Marie Celeste\"",
   "kind": "text",
   "plantedIn": "AS05",
   "usedBy": [
    "P08"
   ],
   "layer": "record"
  },
  {
   "id": "C17",
   "text": "Ticket stub: Adelaide, 1936",
   "kind": "image",
   "plantedIn": "AS03",
   "usedBy": [],
   "layer": "fiction"
  },
  {
   "id": "C18",
   "text": "Ida's catalogue card for the missing leaf",
   "kind": "image",
   "plantedIn": null,
   "usedBy": [
    "P10"
   ],
   "layer": "fiction"
  },
  {
   "id": "C19",
   "text": "The number 297",
   "kind": "text",
   "plantedIn": null,
   "usedBy": [
    "P11"
   ],
   "layer": "pseudo"
  },
  {
   "id": "C20",
   "text": "1959 entry in a different hand",
   "kind": "text",
   "plantedIn": null,
   "usedBy": [
    "P12"
   ],
   "layer": "fiction"
  }
 ],
 "characters": [
  {
   "id": "c-ida",
   "name": "Ida Vance",
   "kind": "fictional",
   "layer": "fiction",
   "life": "1889 – vanished 1937",
   "role": "Keeper of the ledger. Junior cataloguer at Harrow & Sons, Cecil Court, from 1910.",
   "voice": "Dry and exact. Footnotes everything. Writes dates as day.month.year. Never uses the word \"secret\".",
   "secret": "She was recruited by the Concordance in 1912 and began the ledger to expose them.",
   "appears": [
    "P03",
    "P10",
    "N02"
   ],
   "status": "canon"
  },
  {
   "id": "c-mira",
   "name": "Mira Okafor",
   "kind": "persona",
   "layer": "fiction",
   "life": "present day",
   "role": "Archivist who finds the ledger at an estate sale. Runs the blog. The players' ally.",
   "voice": "Warm, curious, slightly overwhelmed. Posts photos with long captions. Lowercase on social.",
   "secret": "She bought the ledger knowing what it was. She is looking for her grandmother.",
   "appears": [
    "P01",
    "P02",
    "AS02"
   ],
   "status": "canon"
  },
  {
   "id": "c-cartographer",
   "name": "The Cartographer",
   "kind": "persona",
   "layer": "fiction",
   "life": "present day",
   "role": "Anonymous account that posts map fragments. Antagonist or guardian.",
   "voice": "Terse. Speaks in bearings and dates. Never asks questions.",
   "secret": "A current member of the Concordance who wants the ledger finished, not hidden.",
   "appears": [
    "AS04"
   ],
   "status": "draft"
  },
  {
   "id": "c-concordance",
   "name": "The Concordance of the Meridian",
   "kind": "faction",
   "layer": "fiction",
   "life": "founded c. 1500?",
   "role": "A society of mapmakers who \"correct\" history. The game's hidden hand.",
   "voice": "Institutional. Latin mottoes. Uses meridians and longitudes for everything.",
   "secret": "Founding date unresolved (see Q05).",
   "appears": [
    "P11",
    "P13"
   ],
   "status": "draft"
  },
  {
   "id": "c-harrow",
   "name": "Eustace Harrow",
   "kind": "fictional",
   "layer": "fiction",
   "life": "1851 – 1919",
   "role": "Rare-book dealer, Ida's employer. Fictional shop on a real street of booksellers.",
   "voice": "Pompous letters, signed \"E.H.\"",
   "secret": "Sold the Concordance its maps.",
   "appears": [
    "P10"
   ],
   "status": "draft"
  },
  {
   "id": "c-voynich",
   "name": "Wilfrid Voynich",
   "kind": "historical",
   "layer": "record",
   "life": "1865 – 1930",
   "role": "Antiquarian bookseller who bought the manuscript in 1912 at Villa Mondragone, Frascati.",
   "voice": "No invented dialogue.",
   "secret": "—",
   "guard": "Real person. Use documented facts only; he never meets Ida on the page.",
   "appears": [
    "P10"
   ],
   "status": "reference"
  },
  {
   "id": "c-troffea",
   "name": "Frau Troffea",
   "kind": "historical",
   "layer": "record",
   "life": "fl. 1518",
   "role": "Named in chronicles as the first dancer in Strasbourg, July 1518.",
   "voice": "—",
   "secret": "—",
   "guard": "Historical figure. Name used as a cipher key only.",
   "appears": [
    "P03"
   ],
   "status": "reference"
  },
  {
   "id": "c-white",
   "name": "John White",
   "kind": "historical",
   "layer": "record",
   "life": "c. 1539 – c. 1593",
   "role": "Governor of the Roanoke colony; found \"CROATOAN\" carved on his return in 1590.",
   "voice": "—",
   "secret": "—",
   "guard": "Historical figure. Documented facts only.",
   "appears": [
    "P05"
   ],
   "status": "reference"
  },
  {
   "id": "c-briggs",
   "name": "Benjamin Briggs",
   "kind": "historical",
   "layer": "record",
   "life": "1835 – 1872",
   "role": "Captain of the Mary Celeste. Lost with his wife, daughter and crew.",
   "voice": "—",
   "secret": "—",
   "guard": "Real family. Do not invent a fate for him.",
   "appears": [
    "P08"
   ],
   "status": "reference"
  },
  {
   "id": "c-illig",
   "name": "Heribert Illig",
   "kind": "living",
   "layer": "pseudo",
   "life": "b. 1947",
   "role": "Author of the phantom time hypothesis (1991).",
   "voice": "—",
   "secret": "—",
   "guard": "Living person. Cite his published claim only. No fiction about him.",
   "appears": [
    "P11"
   ],
   "status": "reference"
  }
 ],
 "places": [
  {
   "id": "pl-somerton",
   "name": "Somerton Park beach, Adelaide",
   "lat": -34.99,
   "lng": 138.51,
   "layer": "record"
  },
  {
   "id": "pl-strasbourg",
   "name": "Strasbourg Cathedral",
   "lat": 48.58,
   "lng": 7.75,
   "layer": "record"
  },
  {
   "id": "pl-tunguska",
   "name": "Tunguska epicentre",
   "lat": 60.89,
   "lng": 101.89,
   "layer": "record"
  },
  {
   "id": "pl-phaistos",
   "name": "Palace of Phaistos, Crete",
   "lat": 35.05,
   "lng": 24.81,
   "layer": "record"
  },
  {
   "id": "pl-roanoke",
   "name": "Roanoke Island",
   "lat": 35.89,
   "lng": -75.66,
   "layer": "record"
  },
  {
   "id": "pl-azores",
   "name": "Where the Mary Celeste was found (approx.)",
   "lat": 38.3,
   "lng": -17.25,
   "layer": "record"
  },
  {
   "id": "pl-bigear",
   "name": "Big Ear site, Delaware, Ohio",
   "lat": 40.25,
   "lng": -83.05,
   "layer": "record"
  },
  {
   "id": "pl-shugborough",
   "name": "Shugborough Hall",
   "lat": 52.8,
   "lng": -2.01,
   "layer": "record"
  },
  {
   "id": "pl-beinecke",
   "name": "Beinecke Library, New Haven",
   "lat": 41.31,
   "lng": -72.93,
   "layer": "record"
  },
  {
   "id": "pl-dyatlov",
   "name": "Dyatlov Pass",
   "lat": 61.75,
   "lng": 59.45,
   "layer": "record"
  },
  {
   "id": "pl-cecil",
   "name": "Harrow & Sons, Cecil Court, London",
   "lat": 51.51,
   "lng": -0.13,
   "layer": "fiction"
  }
 ],
 "timeline": [
  {
   "id": "TL01",
   "date": "1404",
   "title": "Voynich vellum produced (radiocarbon 1404–1438)",
   "layer": "record",
   "links": [
    "E10"
   ]
  },
  {
   "id": "TL02",
   "date": "1513",
   "title": "Piri Reis draws his world map",
   "layer": "record",
   "links": [
    "E14"
   ]
  },
  {
   "id": "TL03",
   "date": "1518-07",
   "title": "Dancing plague begins in Strasbourg",
   "layer": "record",
   "links": [
    "E03",
    "c-troffea",
    "pl-strasbourg"
   ]
  },
  {
   "id": "TL04",
   "date": "1518-07-14",
   "title": "Ledger entry I: \"the first correction\"",
   "layer": "fiction",
   "links": [
    "E03",
    "c-ida"
   ],
   "revealedBy": "P02"
  },
  {
   "id": "TL05",
   "date": "1587",
   "title": "Roanoke colony founded",
   "layer": "record",
   "links": [
    "E05"
   ]
  },
  {
   "id": "TL06",
   "date": "1590-08-18",
   "title": "John White finds \"CROATOAN\" carved on a post",
   "layer": "record",
   "links": [
    "E05",
    "c-white"
   ],
   "revealedBy": "P05"
  },
  {
   "id": "TL07",
   "date": "1750",
   "title": "Shepherd's Monument carved at Shugborough (c.)",
   "layer": "record",
   "links": [
    "E09"
   ]
  },
  {
   "id": "TL08",
   "date": "1872-12-04",
   "title": "Mary Celeste found adrift by the Dei Gratia",
   "layer": "record",
   "links": [
    "E08",
    "c-briggs"
   ],
   "revealedBy": "P08"
  },
  {
   "id": "TL09",
   "date": "1884-01",
   "title": "Conan Doyle publishes \"J. Habakuk Jephson's Statement\"",
   "layer": "record",
   "links": [
    "E08",
    "R10"
   ]
  },
  {
   "id": "TL10",
   "date": "1889",
   "title": "Ida Vance born, Leeds",
   "layer": "fiction",
   "links": [
    "c-ida"
   ]
  },
  {
   "id": "TL11",
   "date": "1908-06-30",
   "title": "Tunguska airburst",
   "layer": "record",
   "links": [
    "E04"
   ],
   "revealedBy": "P04"
  },
  {
   "id": "TL12",
   "date": "1908-07-03",
   "title": "Phaistos Disc found (date needs primary source)",
   "layer": "record",
   "links": [
    "E04",
    "Q02"
   ],
   "revealedBy": "P04"
  },
  {
   "id": "TL13",
   "date": "1912",
   "title": "Voynich buys the manuscript at Villa Mondragone",
   "layer": "record",
   "links": [
    "E10",
    "c-voynich"
   ]
  },
  {
   "id": "TL14",
   "date": "1912-05",
   "title": "Ida begins the ledger",
   "layer": "fiction",
   "links": [
    "c-ida"
   ],
   "revealedBy": "P10"
  },
  {
   "id": "TL15",
   "date": "1937",
   "title": "Ida Vance vanishes",
   "layer": "fiction",
   "links": [
    "c-ida"
   ]
  },
  {
   "id": "TL16",
   "date": "1948-12-01",
   "title": "Somerton Man found on Somerton Park beach",
   "layer": "record",
   "links": [
    "E01"
   ],
   "revealedBy": "P01"
  },
  {
   "id": "TL17",
   "date": "1959-02",
   "title": "Ledger entry in a different hand",
   "layer": "fiction",
   "links": [
    "E12",
    "Q01"
   ],
   "revealedBy": "P12"
  },
  {
   "id": "TL18",
   "date": "1959-02-02",
   "title": "Dyatlov Pass incident",
   "layer": "pseudo",
   "links": [
    "E12"
   ],
   "revealedBy": "P12"
  },
  {
   "id": "TL19",
   "date": "1966",
   "title": "Hapgood's \"Maps of the Ancient Sea Kings\"",
   "layer": "pseudo",
   "links": [
    "E14",
    "R18"
   ]
  },
  {
   "id": "TL20",
   "date": "1977-08-15",
   "title": "The Wow! signal",
   "layer": "record",
   "links": [
    "E07"
   ],
   "revealedBy": "P07"
  },
  {
   "id": "TL21",
   "date": "1991",
   "title": "Illig proposes phantom time",
   "layer": "pseudo",
   "links": [
    "E11",
    "c-illig"
   ],
   "revealedBy": "P11"
  },
  {
   "id": "TL22",
   "date": "2022-07",
   "title": "Researchers name the Somerton Man",
   "layer": "pseudo",
   "links": [
    "E01",
    "R02"
   ]
  },
  {
   "id": "TL23",
   "date": "2026-09-26",
   "title": "Mira finds the ledger at an estate sale",
   "layer": "fiction",
   "links": [
    "c-mira"
   ],
   "revealedBy": "P02"
  }
 ],
 "assets": [
  {
   "id": "AS01",
   "name": "Classified ad",
   "kind": "print",
   "status": "ready",
   "chapter": "CH0",
   "where": "Newspaper classifieds + online mirror",
   "persona": null,
   "renews": null,
   "carries": [
    "C01",
    "C02"
   ],
   "cost": "$38"
  },
  {
   "id": "AS02",
   "name": "mira-okafor.blog",
   "kind": "domain",
   "status": "ready",
   "chapter": "CH0",
   "where": "mira-okafor.blog",
   "persona": "c-mira",
   "renews": "2026-11-02",
   "carries": [],
   "cost": "$14/yr"
  },
  {
   "id": "AS03",
   "name": "Ledger page photo",
   "kind": "image",
   "status": "ready",
   "chapter": "CH0",
   "where": "mira-okafor.blog/estate-sale",
   "persona": "c-mira",
   "renews": null,
   "carries": [
    "C03",
    "C04",
    "C14",
    "C17"
   ]
  },
  {
   "id": "AS04",
   "name": "@the_cartographer",
   "kind": "social",
   "status": "making",
   "chapter": "CH1",
   "where": "Social account, backdated posts",
   "persona": "c-cartographer",
   "renews": null,
   "carries": []
  },
  {
   "id": "AS05",
   "name": "ledger-folio-1.pdf",
   "kind": "document",
   "status": "ready",
   "chapter": "CH1",
   "where": "Unlisted page on mira-okafor.blog",
   "persona": "c-ida",
   "renews": null,
   "carries": [
    "C05",
    "C06",
    "C08",
    "C15",
    "C16"
   ]
  },
  {
   "id": "AS06",
   "name": "Voicemail line",
   "kind": "phone",
   "status": "making",
   "chapter": "CH1",
   "where": "Virtual number, monthly plan",
   "persona": "c-mira",
   "renews": "2026-10-20",
   "carries": [],
   "cost": "$5/mo"
  },
  {
   "id": "AS07",
   "name": "bigear_72s.wav",
   "kind": "audio",
   "status": "idea",
   "chapter": "CH2",
   "where": "—",
   "persona": "c-cartographer",
   "renews": null,
   "carries": [
    "C12"
   ]
  },
  {
   "id": "AS08",
   "name": "Folio Three insert",
   "kind": "physical",
   "status": "idea",
   "chapter": "CH1",
   "where": "A copy of the Rubáiyát (where: see Q03)",
   "persona": "c-ida",
   "renews": null,
   "carries": [
    "C11",
    "C13"
   ]
  },
  {
   "id": "AS09",
   "name": "meridianledger.net",
   "kind": "domain",
   "status": "ready",
   "chapter": "CH3",
   "where": "Registered, parked",
   "persona": "c-concordance",
   "renews": "2027-02-01",
   "carries": [],
   "cost": "$12/yr"
  },
  {
   "id": "AS10",
   "name": "Phaistos glyph cards",
   "kind": "image",
   "status": "ready",
   "chapter": "CH1",
   "where": "Folio One appendix",
   "persona": "c-ida",
   "renews": null,
   "carries": [
    "C07"
   ]
  },
  {
   "id": "AS11",
   "name": "Croatoan photo series",
   "kind": "image",
   "status": "making",
   "chapter": "CH1",
   "where": "Cartographer posts, 3 parts",
   "persona": "c-cartographer",
   "renews": null,
   "carries": [
    "C09"
   ]
  }
 ],
 "research": [
  {
   "id": "R01",
   "title": "Tamam Shud case",
   "url": "https://en.wikipedia.org/wiki/Tamam_Shud_case",
   "author": "Wikipedia",
   "year": null,
   "kind": "web",
   "reliability": "popular",
   "status": "read",
   "excerpt": "The scrap of paper bearing the words \"Tamám Shud\" was torn from the final page of a copy of the Rubáiyát.",
   "notes": "Good overview; follow its citations for the code photos.",
   "supports": [
    "E01",
    "P01"
   ],
   "tags": [
    "somerton",
    "code"
   ]
  },
  {
   "id": "R02",
   "title": "Reporting on the 2022 identification",
   "url": null,
   "author": "Various",
   "year": 2022,
   "kind": "article",
   "reliability": "popular",
   "status": "to read",
   "excerpt": "",
   "notes": "Find the primary announcement before quoting anything.",
   "supports": [
    "E01"
   ],
   "tags": [
    "somerton",
    "ethics"
   ]
  },
  {
   "id": "R03",
   "title": "Dancing plague of 1518",
   "url": "https://en.wikipedia.org/wiki/Dancing_plague_of_1518",
   "author": "Wikipedia",
   "year": null,
   "kind": "web",
   "reliability": "popular",
   "status": "read",
   "excerpt": "The outbreak began in July 1518 when a woman, Frau Troffea, began to dance fervently in a street in Strasbourg.",
   "notes": "",
   "supports": [
    "E03",
    "c-troffea"
   ],
   "tags": [
    "strasbourg"
   ]
  },
  {
   "id": "R04",
   "title": "A Time to Dance, a Time to Die",
   "url": null,
   "author": "John Waller",
   "year": 2008,
   "kind": "book",
   "reliability": "scholarly",
   "status": "verified",
   "excerpt": "",
   "notes": "Source for the chronicle accounts and the Troffea name.",
   "supports": [
    "E03",
    "P03"
   ],
   "tags": [
    "strasbourg",
    "book"
   ]
  },
  {
   "id": "R05",
   "title": "Tunguska event",
   "url": "https://en.wikipedia.org/wiki/Tunguska_event",
   "author": "Wikipedia",
   "year": null,
   "kind": "web",
   "reliability": "popular",
   "status": "verified",
   "excerpt": "The explosion over the sparsely populated East Siberian taiga flattened an estimated 80 million trees over an area of 2,150 km².",
   "notes": "Date 30 June 1908 confirmed in several sources.",
   "supports": [
    "E04",
    "P04",
    "TL11"
   ],
   "tags": [
    "1908"
   ]
  },
  {
   "id": "R06",
   "title": "Phaistos Disc",
   "url": "https://en.wikipedia.org/wiki/Phaistos_Disc",
   "author": "Wikipedia",
   "year": null,
   "kind": "web",
   "reliability": "popular",
   "status": "read",
   "excerpt": "",
   "notes": "Gives 1908; need the exact day from a primary source (Q02).",
   "supports": [
    "E04",
    "P04"
   ],
   "tags": [
    "1908",
    "glyphs"
   ]
  },
  {
   "id": "R07",
   "title": "Pernier's excavation report, Phaistos",
   "url": null,
   "author": "Luigi Pernier",
   "year": 1908,
   "kind": "archive",
   "reliability": "primary",
   "status": "to read",
   "excerpt": "",
   "notes": "This is the one that settles 3 July. Check a university library.",
   "supports": [
    "E04",
    "P04",
    "Q02"
   ],
   "tags": [
    "1908",
    "primary"
   ]
  },
  {
   "id": "R08",
   "title": "Roanoke Colony",
   "url": "https://en.wikipedia.org/wiki/Roanoke_Colony",
   "author": "Wikipedia",
   "year": null,
   "kind": "web",
   "reliability": "popular",
   "status": "verified",
   "excerpt": "White found the word \"CROATOAN\" carved into a palisade post and \"CRO\" carved into a nearby tree.",
   "notes": "",
   "supports": [
    "E05",
    "P05",
    "c-white"
   ],
   "tags": [
    "roanoke"
   ]
  },
  {
   "id": "R09",
   "title": "Mary Celeste",
   "url": "https://en.wikipedia.org/wiki/Mary_Celeste",
   "author": "Wikipedia",
   "year": null,
   "kind": "web",
   "reliability": "popular",
   "status": "verified",
   "excerpt": "",
   "notes": "Found 4 Dec 1872 by the Dei Gratia.",
   "supports": [
    "E08",
    "c-briggs"
   ],
   "tags": [
    "sea"
   ]
  },
  {
   "id": "R10",
   "title": "J. Habakuk Jephson's Statement",
   "url": "https://en.wikipedia.org/wiki/J._Habakuk_Jephson%27s_Statement",
   "author": "Arthur Conan Doyle",
   "year": 1884,
   "kind": "story",
   "reliability": "primary",
   "status": "verified",
   "excerpt": "",
   "notes": "Uses \"Marie Celeste\". The book-cipher key for P08; find a scan of the Cornhill printing for page numbers.",
   "supports": [
    "E08",
    "P08"
   ],
   "tags": [
    "sea",
    "book-cipher"
   ]
  },
  {
   "id": "R11",
   "title": "Wow! signal",
   "url": "https://en.wikipedia.org/wiki/Wow!_signal",
   "author": "Wikipedia",
   "year": null,
   "kind": "web",
   "reliability": "popular",
   "status": "verified",
   "excerpt": "The signal's intensity was recorded as \"6EQUJ5\", where 0–9 and then A–Z denote increasing intensity.",
   "notes": "",
   "supports": [
    "E07",
    "P07"
   ],
   "tags": [
    "signal"
   ]
  },
  {
   "id": "R12",
   "title": "Shugborough inscription",
   "url": "https://en.wikipedia.org/wiki/Shugborough_inscription",
   "author": "Wikipedia",
   "year": null,
   "kind": "web",
   "reliability": "popular",
   "status": "read",
   "excerpt": "",
   "notes": "Lots of fringe readings listed. Good flavour, none of them canon for us.",
   "supports": [
    "E09",
    "P09"
   ],
   "tags": [
    "letters"
   ]
  },
  {
   "id": "R13",
   "title": "Voynich manuscript",
   "url": "https://en.wikipedia.org/wiki/Voynich_manuscript",
   "author": "Wikipedia",
   "year": null,
   "kind": "web",
   "reliability": "popular",
   "status": "read",
   "excerpt": "",
   "notes": "Look at the Beinecke digital facsimile for the foliation gaps.",
   "supports": [
    "E10",
    "P10"
   ],
   "tags": [
    "manuscript"
   ]
  },
  {
   "id": "R14",
   "title": "Phantom time hypothesis",
   "url": "https://en.wikipedia.org/wiki/Phantom_time_hypothesis",
   "author": "Wikipedia",
   "year": null,
   "kind": "web",
   "reliability": "popular",
   "status": "read",
   "excerpt": "",
   "notes": "Rebuttals summarised here; use them in the credits page.",
   "supports": [
    "E11"
   ],
   "tags": [
    "fringe"
   ]
  },
  {
   "id": "R15",
   "title": "Das erfundene Mittelalter",
   "url": null,
   "author": "Heribert Illig",
   "year": 1996,
   "kind": "book",
   "reliability": "fringe",
   "status": "verified",
   "excerpt": "",
   "notes": "The claim itself. Cite, don't endorse.",
   "supports": [
    "E11",
    "P11"
   ],
   "tags": [
    "fringe",
    "book"
   ]
  },
  {
   "id": "R16",
   "title": "Dyatlov Pass incident",
   "url": "https://en.wikipedia.org/wiki/Dyatlov_Pass_incident",
   "author": "Wikipedia",
   "year": null,
   "kind": "web",
   "reliability": "popular",
   "status": "read",
   "excerpt": "",
   "notes": "",
   "supports": [
    "E12"
   ],
   "tags": [
    "1959"
   ]
  },
  {
   "id": "R17",
   "title": "Mechanisms of slab avalanche release … Dyatlov Pass",
   "url": null,
   "author": "Gaume & Puzrin",
   "year": 2021,
   "kind": "article",
   "reliability": "scholarly",
   "status": "verified",
   "excerpt": "",
   "notes": "Communications Earth & Environment, 2021.",
   "supports": [
    "E12",
    "P12"
   ],
   "tags": [
    "1959"
   ]
  },
  {
   "id": "R18",
   "title": "Piri Reis map",
   "url": "https://en.wikipedia.org/wiki/Piri_Reis_map",
   "author": "Wikipedia",
   "year": null,
   "kind": "web",
   "reliability": "popular",
   "status": "to read",
   "excerpt": "",
   "notes": "For the parking-lot overlay idea.",
   "supports": [
    "E14"
   ],
   "tags": [
    "maps",
    "fringe"
   ]
  }
 ],
 "ideas": [
  {
   "id": "I01",
   "text": "Antikythera mechanism, recovered 1901. Another object that \"surfaced\"? Chapter 3?",
   "url": "https://en.wikipedia.org/wiki/Antikythera_mechanism",
   "tags": [
    "object",
    "ch3"
   ],
   "status": "raw",
   "created": "2026-10-06",
   "links": []
  },
  {
   "id": "I02",
   "text": "Morse code hidden in a ship's bell recording (Mary Celeste tie-in).",
   "url": null,
   "tags": [
    "audio",
    "mechanic"
   ],
   "status": "exploring",
   "created": "2026-10-06",
   "links": [
    "E08",
    "P08"
   ]
  },
  {
   "id": "I03",
   "text": "Hessdalen lights as a night-time photo puzzle.",
   "url": "https://en.wikipedia.org/wiki/Hessdalen_lights",
   "tags": [
    "lights"
   ],
   "status": "raw",
   "created": "2026-10-05",
   "links": []
  },
  {
   "id": "I04",
   "text": "Gef the talking mongoose (1931, Isle of Man) as a comic-relief side path?",
   "url": null,
   "tags": [
    "tone"
   ],
   "status": "parked",
   "created": "2026-10-04",
   "links": []
  },
  {
   "id": "I05",
   "text": "Mira mentions her grandmother exactly once in Chapter 1. Plant it, don't explain it.",
   "url": null,
   "tags": [
    "character",
    "setup"
   ],
   "status": "exploring",
   "created": "2026-10-04",
   "links": [
    "c-mira"
   ]
  },
  {
   "id": "I06",
   "text": "Ida's day.month.year dates could double as coordinates if read the other way.",
   "url": null,
   "tags": [
    "mechanic"
   ],
   "status": "raw",
   "created": "2026-10-02",
   "links": [
    "c-ida"
   ]
  },
  {
   "id": "I07",
   "text": "Use the real Somerton code's first line in the ad.",
   "url": null,
   "tags": [
    "trailhead"
   ],
   "status": "used",
   "created": "2026-09-08",
   "links": [
    "P01",
    "C01"
   ]
  }
 ],
 "questions": [
  {
   "id": "Q01",
   "kind": "continuity",
   "severity": "high",
   "status": "open",
   "created": "2026-09-30",
   "text": "Ida vanished in 1937, so who wrote the 1959 Dyatlov entry?",
   "links": [
    "c-ida",
    "TL17",
    "P12"
   ]
  },
  {
   "id": "Q02",
   "kind": "research",
   "severity": "high",
   "status": "open",
   "created": "2026-10-02",
   "text": "Confirm the Phaistos Disc was found on 3 July 1908 from a primary source. P04 depends on the 3-day gap.",
   "links": [
    "E04",
    "P04",
    "R07"
   ]
  },
  {
   "id": "Q03",
   "kind": "ethics",
   "severity": "high",
   "status": "open",
   "created": "2026-10-01",
   "text": "Folio Three: ask a library for permission to leave it in their copy, or use our own copy at a friendly bookshop? It has to stay put for as long as the game is out.",
   "links": [
    "P06",
    "AS08"
   ]
  },
  {
   "id": "Q04",
   "kind": "ethics",
   "severity": "med",
   "status": "resolved",
   "created": "2026-09-10",
   "text": "The Somerton Man has a named identity and living relatives. How close can the fiction get?",
   "links": [
    "E01"
   ],
   "resolution": "Fiction touches the pencilled code only, never the man or his family."
  },
  {
   "id": "Q05",
   "kind": "design",
   "severity": "med",
   "status": "open",
   "created": "2026-10-03",
   "text": "Is the 297-year shift a repeatable mechanic or a one-time Chapter 3 reveal?",
   "links": [
    "E11",
    "P11",
    "c-concordance"
   ]
  },
  {
   "id": "Q06",
   "kind": "design",
   "severity": "med",
   "status": "open",
   "created": "2026-10-05",
   "text": "Chapter 2 leans on ciphers (P08, P09). Swap one for something physical or spatial?",
   "links": [
    "CH2",
    "P08",
    "P09"
   ]
  },
  {
   "id": "Q07",
   "kind": "research",
   "severity": "low",
   "status": "resolved",
   "created": "2026-09-20",
   "text": "Did Doyle's story popularise the \"Marie Celeste\" spelling?",
   "links": [
    "E08",
    "R10"
   ],
   "resolution": "Yes. The 1884 story used \"Marie Celeste\"."
  },
  {
   "id": "Q08",
   "kind": "continuity",
   "severity": "low",
   "status": "open",
   "created": "2026-10-06",
   "text": "Everything goes live at once, so the Cartographer's posts need believable backdated timestamps that never mention the estate sale before Mira's post.",
   "links": [
    "c-cartographer",
    "AS04"
   ]
  }
 ],
 "tasks": [
  {
   "id": "T01",
   "title": "Renew mira-okafor.blog (and set auto-renew for as long as the game is out)",
   "status": "todo",
   "links": [
    "AS02"
   ]
  },
  {
   "id": "T02",
   "title": "Offer a direct file link for the P02 photo (iOS strips GPS)",
   "status": "doing",
   "links": [
    "P02",
    "AS03"
   ]
  },
  {
   "id": "T03",
   "title": "Record Mira's voicemail greeting",
   "status": "todo",
   "links": [
    "AS06",
    "c-mira"
   ]
  },
  {
   "id": "T04",
   "title": "Re-test P04 with an arrow glyph on the disc",
   "status": "todo",
   "links": [
    "P04"
   ]
  },
  {
   "id": "T05",
   "title": "Find Pernier's report or a scholarly citation for the date",
   "status": "doing",
   "links": [
    "Q02",
    "R07"
   ]
  },
  {
   "id": "T06",
   "title": "Shoot the six prop posts",
   "status": "todo",
   "links": [
    "AS11",
    "P05"
   ]
  },
  {
   "id": "T07",
   "title": "Write and backdate the Cartographer's posts",
   "status": "doing",
   "links": [
    "AS04",
    "c-cartographer",
    "Q08"
   ]
  },
  {
   "id": "T08",
   "title": "Typeset Folio One PDF",
   "status": "done",
   "links": [
    "AS05"
   ]
  },
  {
   "id": "T09",
   "title": "Draft the fact vs. fiction credits page",
   "status": "todo",
   "links": [
    "E11"
   ]
  },
  {
   "id": "T10",
   "title": "Decide: ticket stub (C17) canon or cut",
   "status": "todo",
   "links": [
    "C17"
   ]
  }
 ],
 "notes": [
  {
   "id": "N01",
   "title": "Chapter 1: the 1908 thing",
   "updated": "2026-10-02",
   "body": "Big realization: [[Tunguska]] (30 June 1908) and the [[Phaistos Disc]] (found 3 July 1908) are three days apart. Players can check that. Build #P04 around it: the disc's spiral gives the order, the gap gives the shift (3).\n\nDoes Pernier's report actually say 3 July, or is that a later retelling? See #R07 and #Q02.\n\n@Ida Vance would have been 19 in 1908. Her ledger doesn't start until 1912, so she's backfilling these entries.\n\nFriend test went badly: 1 of 4 solved #P04. Everyone read the spiral outside-in. Either make that the answer or add an arrow glyph."
  },
  {
   "id": "N02",
   "title": "Ida — character dump",
   "updated": "2026-09-28",
   "body": "@Ida Vance. b. 1889 Leeds. Junior cataloguer at Harrow & Sons, Cecil Court (fictional shop, real street) from 1910.\n\nShe's around when @Wilfrid Voynich buys the manuscript in 1912. Careful: he bought it from the Jesuits at Villa Mondragone, Frascati, not in London. So Ida has to travel. Italy trip, spring 1912.\n\nVoice: dry, exact, footnotes everything. Writes dates as day.month.year. Never uses the word \"secret\".\n\nWho keeps writing in the ledger after she vanishes in 1937? The 1948 and 1959 entries are in a different hand. The Concordance? Mira's grandmother? (#Q01)"
  },
  {
   "id": "N03",
   "title": "Phantom time: mechanic or reveal?",
   "updated": "2026-10-03",
   "body": "Illig's claim (1991): 614–911 AD never happened, 297 years were inserted. #R15\n\nOur twist: the Concordance didn't insert years, they REMOVED events, and the ledger is the list of what was removed.\n\nIf every ledger date shifts by 297, the Strasbourg entry (1518) lands on 1221. Is there anything at Strasbourg in 1221? Research.\n\nTone: we're playing with a fringe theory, not endorsing it. After the finale, a credits page separates fact from fiction (#T09)."
  }
 ]
};
