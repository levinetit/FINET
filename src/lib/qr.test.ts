import { describe, expect, it } from "vitest";

import { QrTooLongError, qrMatrix, qrSvgPath, qrVersionFor } from "./qr";

/**
 * Vectori de referință generați cu o bibliotecă INDEPENDENTĂ (python-qrcode 8.2, BSD):
 * `QRCode(version=V, error_correction=M, mask_pattern=K, border=0)` cu datele în modul byte
 * (UTF-8), rândurile matricei ca hex (biții completați cu 0 până la multiplu de 4); `autoVersion` =
 * versiunea minimă aleasă de aceeași bibliotecă (`fit=True`). Comparăm modul cu modul: datele,
 * completarea, corecția Reed–Solomon, întrețeserea blocurilor, tiparele, biții de format și de
 * versiune (v7+) și măștile. (segno 1.6.6 nu a putut fi folosit: adaugă un octet 0x00 după
 * terminator când datele sunt deja aliniate la octet; codul rămâne valid, dar nu identic.)
 */
const VECTORS: readonly {
  text: string;
  version: number;
  mask: number;
  autoVersion: number;
  rows: readonly string[];
}[] = [
  {
    text: "FINET",
    version: 1,
    mask: 0,
    autoVersion: 1,
    rows: [
      "fe23f8",
      "82a208",
      "ba1ae8",
      "ba3ae8",
      "baeae8",
      "822a08",
      "feabf8",
      "007800",
      "aa7090",
      "308270",
      "fa88f8",
      "f1a218",
      "beaab8",
      "00b530",
      "fe5718",
      "821d80",
      "baf738",
      "ba4310",
      "ba88e8",
      "824310",
      "feabf8",
    ],
  },
  {
    text: "https://github.com/exemplu/finet/releases/download/FINET-v1.0.0/finet-1.0.0.apk",
    version: 5,
    mask: 3,
    autoVersion: 5,
    rows: [
      "fe983923f8",
      "82f58b6208",
      "ba788bf2e8",
      "ba9ddbf2e8",
      "ba1652bae8",
      "8230984a08",
      "feaaaaabf8",
      "00ba731800",
      "b777e41258",
      "3c7d974b10",
      "777b6bc960",
      "95173066e0",
      "2b624166f8",
      "e49558f7c8",
      "ff5810acb0",
      "89b42c0190",
      "ce18a46068",
      "b8d2c7b958",
      "831182b078",
      "882a5289d0",
      "ab886c0d88",
      "fcc2f90c40",
      "724a83af00",
      "992638c4e0",
      "139f20deb8",
      "31e8daedf8",
      "5bddb4a430",
      "811a853a10",
      "278f2e4fa8",
      "00ad4b98a8",
      "febbc4eab8",
      "82a9133888",
      "ba442f0fd8",
      "baeb31b6a8",
      "bab2c90ee0",
      "8214a86fe0",
      "fea7d260f8",
    ],
  },
  {
    text: "https://finet.exemplu.invalid/settings/android",
    version: 4,
    mask: 6,
    autoVersion: 4,
    rows: [
      "fe8aaabf8",
      "829050a08",
      "bab97c2e8",
      "ba4004ae8",
      "bac7282e8",
      "82760d208",
      "feaaaabf8",
      "005c39000",
      "9fa3d94b8",
      "5139330f0",
      "1653ef4f8",
      "ec12cb720",
      "7336efb08",
      "ec80d1460",
      "aa6ca4a20",
      "5de111ce8",
      "930a1bfc0",
      "2c133c2b8",
      "771599f68",
      "7524fd2e8",
      "82901d040",
      "a1f2ef180",
      "972785eb8",
      "a9e6e33a8",
      "c2ad91fc0",
      "00c9808b0",
      "feb53faa0",
      "82f0818f0",
      "bae57df88",
      "bae448d08",
      "ba748d5d8",
      "823da21f8",
      "fea6c1f80",
    ],
  },
  {
    text: "A".repeat(150),
    version: 8,
    mask: 5,
    autoVersion: 8,
    rows: [
      "fe7b9aaaacbf8",
      "82b790820fa08",
      "bae9ec9249ae8",
      "baa2bffffd2e8",
      "ba4927e7182e8",
      "821bb6220a208",
      "feaaaaaaaabf8",
      "00a3e22208000",
      "82d947e71d670",
      "f8857bfffffa8",
      "bb1af09248218",
      "a058c48208258",
      "5a3d1eaaabaf8",
      "2d9f39d75d708",
      "677fe89248218",
      "200136aaaaaf8",
      "1f08c5c71d748",
      "b180f1d75d708",
      "a7b58bfffefa8",
      "b1e4448208258",
      "d6c345c71d748",
      "15315bfffffa8",
      "2fb2f7f248f98",
      "08af6622088d8",
      "7ad2deaaabaf8",
      "38cb36375c888",
      "7fce37f249f98",
      "299caaaaaa2f8",
      "bbd9a4871da48",
      "1493a3d75c708",
      "27b62cbfffaa8",
      "588ea08208a40",
      "f2a424871da58",
      "986379fffefa8",
      "a313b7d249718",
      "f0d8208208a58",
      "27e73feaab7f8",
      "2de1f3d75c708",
      "460277d249718",
      "71b90aaaaa2f8",
      "e20ba7e71dfc8",
      "00f852375d888",
      "fe620abfffaa8",
      "820b4222088d8",
      "ba28a3e71dfc8",
      "ba527abffeab8",
      "ba3a55d248700",
      "8267c5c209748",
      "fea03beaabfe8",
    ],
  },
  {
    text: "ă".repeat(90) + "x",
    version: 10,
    mask: 7,
    autoVersion: 10,
    rows: [
      "fe1a43508b8f3f8",
      "82258a9d65d1208",
      "ba459bce38e32e8",
      "ba1e775aaaa92e8",
      "ba22c83f71c52e8",
      "82f80262471a208",
      "feaaaaaaaaaabf8",
      "0040f4227593000",
      "96a9bdbef063d00",
      "28cd7cd35767f50",
      "cbdc3912df38f50",
      "9526f015c77d778",
      "cee1cbb35514d38",
      "b54333179e38e00",
      "9634f8d620e20f8",
      "344267551111160",
      "9e7f7ead06b0ea8",
      "f43e35f7e53ed18",
      "aedfb95bbbbabc0",
      "ddf4fd7c77c61a0",
      "ea9feb93c31df70",
      "fdeab58cabaaa90",
      "8b8b1ce78fb9620",
      "5d18fd50835e320",
      "9ba3f2a4a222a28",
      "1800bc9b53e7bc0",
      "4fadf07e29f3f88",
      "9886672335558b0",
      "aad858aa31c7aa8",
      "d8c4fca238f28d8",
      "3fbd22beaab2fb0",
      "d4b97c0c25c38f8",
      "aea25daab82a0e0",
      "8126a88d67562c8",
      "fb8aaa788f689d0",
      "e96c29b1c71c778",
      "067cd2db5555ea8",
      "2511abdb8e39900",
      "3b8b5db838e3af8",
      "b0f92a551411c68",
      "c36e36c70231638",
      "9dd611a9e63f098",
      "0adf0d31bebad40",
      "48f2551c71c11a0",
      "a61eefc9c718cf0",
      "a8b543bfaaabd90",
      "a6f9d6c40e38c20",
      "f81b7361c348e20",
      "028274fe622bfa8",
      "00cca2a273f48c0",
      "fe43a62b69e2a88",
      "82d9c32355358b0",
      "ba2753fe7186fa8",
      "bab8a87428e2758",
      "ba4047b2b2aa528",
      "8227ad663583660",
      "feb731eeb06a8f0",
    ],
  },
  {
    text: "https://github.com/exemplu/finet/releases/tag/FINET-v12.34.567",
    version: 7,
    mask: 2,
    autoVersion: 4,
    rows: [
      "fe1b447a8bf8",
      "821d2f885208",
      "ba877c8712e8",
      "bad3aec41ae8",
      "ba967f837ae8",
      "8285c8c04208",
      "feaaaaaaabf8",
      "00e908da1000",
      "be5bdfc7bbe0",
      "b8f335ca88f8",
      "b61890efff30",
      "fc9965d48f20",
      "5b5af0890088",
      "50ea829d1dc0",
      "36afe72a3298",
      "5c9c7a04ae48",
      "bf112d516338",
      "7ceadb073e20",
      "af5b4cd15160",
      "75dc81f451b8",
      "4f8fcfa59ff0",
      "78eda8fec8f8",
      "8aab3a8b8ab0",
      "e8c3e8bd68f0",
      "afc32f901fd0",
      "f9d2fac50c48",
      "4edb2b2a2850",
      "5d593fe2c468",
      "273e95d73ad8",
      "dccd0b425230",
      "ab16d2f77160",
      "445e7f73d330",
      "4796ba2d0460",
      "5d18057e4d58",
      "0b7c0d888c00",
      "78a1e0973b48",
      "9b086fc06fb0",
      "00f2788738e8",
      "fe681ada5ab0",
      "82cbe8da18e8",
      "baac0fc7dfd8",
      "bae51dca8938",
      "ba9aa0aff480",
      "820f4955a1e0",
      "feb160a93490",
    ],
  },
  {
    text: "https://github.com/exemplu/finet/releases/tag/FINET-v12.34.567",
    version: 4,
    mask: 1,
    autoVersion: 4,
    rows: [
      "fefe663f8",
      "8206e6a08",
      "baeffd2e8",
      "ba05dc2e8",
      "ba28c62e8",
      "82beaca08",
      "feaaaabf8",
      "0058a8000",
      "a33983128",
      "1cc99da58",
      "2311f1e68",
      "09a3aa7d8",
      "76ff3ca00",
      "848575b18",
      "6371d98c8",
      "6031a8e40",
      "9f0099b50",
      "997bb9a48",
      "825731b78",
      "2dc598cc0",
      "cb20a5308",
      "513109f48",
      "d37df32a8",
      "3d0a8bf48",
      "e2bf98fc0",
      "008355898",
      "fee316ae8",
      "82728b8d0",
      "ba292df88",
      "ba196d5f8",
      "bac9595f8",
      "82251a9c0",
      "fe8d099c8",
    ],
  },
];

const toHex = (row: readonly boolean[]): string => {
  const bits = row
    .map((b) => (b ? "1" : "0"))
    .join("")
    .padEnd(Math.ceil(row.length / 4) * 4, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 4) {
    out += Number.parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return out;
};

describe("generatorul QR (nivel M, mod byte)", () => {
  for (const v of VECTORS) {
    it(`identic cu python-qrcode: v${v.version}, masca ${v.mask}, ${v.text.length} caractere`, () => {
      const m = qrMatrix(v.text, { version: v.version, mask: v.mask });
      expect(m.length).toBe(v.version * 4 + 17);
      expect(m.map(toHex)).toEqual(v.rows);
    });
    it(`versiunea minimă = cea a bibliotecii de referință (${v.autoVersion})`, () => {
      expect(qrVersionFor(new TextEncoder().encode(v.text).length)).toBe(v.autoVersion);
      expect(qrMatrix(v.text).length).toBe(v.autoVersion * 4 + 17);
    });
  }

  it("masca automată dă una dintre cele 8 măști valide (aceleași date, aceeași versiune)", () => {
    const v = VECTORS[1]!;
    const auto = qrMatrix(v.text, { version: v.version });
    const candidates = [0, 1, 2, 3, 4, 5, 6, 7].map((mask) =>
      qrMatrix(v.text, { version: v.version, mask }).map(toHex).join(","),
    );
    expect(candidates).toContain(auto.map(toHex).join(","));
  });

  it("text prea lung (> 213 octeți) sau versiune prea mică → eroare", () => {
    expect(() => qrMatrix("x".repeat(214))).toThrow(QrTooLongError);
    expect(() => qrMatrix("x".repeat(30), { version: 1 })).toThrow(QrTooLongError);
    expect(() => qrMatrix("abc", { mask: 8 })).toThrow();
  });

  it("calea SVG: un pătrat pe modul închis, cu marginea liniștită de 4", () => {
    const m = qrMatrix("FINET", { version: 1, mask: 0 });
    const dark = m.flat().filter(Boolean).length;
    const { d, size } = qrSvgPath(m);
    expect(size).toBe(21 + 8);
    expect(d.match(/M\d+ \d+h1v1h-1z/g)?.length).toBe(dark);
    expect(d.startsWith("M4 4h1v1h-1z")).toBe(true); // colțul tiparului de poziționare
  });
});
