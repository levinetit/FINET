import type { SiteMessages } from "./en-site";

/**
 * `saas` sitesinin HERKESE AÇIK SAYFALARININ Türkçe metinleri (Faz 13, ADR 0033). İngilizce metnin
 * çalışma çevirisidir; biçimi `SiteMessages` türü belirler ve bir test hiçbir anahtarın eksik
 * olmadığını doğrular. Başvuru metni Romence sürümdür.
 */
export const trSite: SiteMessages = {
  nav: {
    pricing: "Fiyatlar",
    terms: "Koşullar",
    privacy: "Gizlilik",
    support: "Destek",
    login: "Giriş yap",
    register: "Hesap oluştur",
    language: "Dil",
    skip: "İçeriğe geç",
  },
  landing: {
    title: "FINET: sizin ve ailenizin finansı tek bir yerde",
    lead: "Hesaplarınızı, harcamalarınızı ve bütçelerinizi takip edin, fişleri tarayın ve paranın nereye gittiğini görün.",
    features: [
      "Fotoğraf veya PDF'den okunan fişler, kaydetmeden önce sizin kontrolünüzle",
      "Aya, kategoriye ve satıcıya göre bütçeler, hedefler ve raporlar",
      "Aile: ortak ve kişisel hesaplar, bakiyeler ve hesaplaşmalar",
      "Banka ekstreleri, alışveriş listeleri ve ürün başına fiyatlar",
      "CSV, Excel ve PDF olarak dışa aktarma ve muhasebeciniz için bir dışa aktarma",
      "Verileriniz sizin kontrolünüzde: doğrudan uygulamadan dışa aktarın ve silin",
    ],
    cta: "Hesap oluştur",
    secondary: "Zaten hesabınız var mı? Giriş yapın",
  },
  pricing: {
    title: "Fiyatlar",
    body: "Planlar ve fiyatlar yayına girdiğinde burada yayımlanacaktır. O zamana kadar hizmette henüz ücretli plan yoktur.",
  },
  support: {
    title: "Destek",
    lead: "FINET'in kullanımı hakkında kısa yanıtlar. Aradığınızı bulamazsanız bize yazın.",
    sections: [
      {
        id: "inceput",
        title: "Nasıl başlarım?",
        body: "E-posta adresinizle hesabınızı oluşturun, ardından hesaplarınızı (nakit, banka, kart) ve ilk işlemlerinizi ekleyin. Her yeni hesap, daha sonra genişletebileceğiniz kişisel bir hane alır.",
      },
      {
        id: "bonuri",
        title: "Fişler",
        body: "Bir fişin fotoğrafını veya PDF'sini yükleyin; FINET okuduğu verileri önerir, siz de kaydetmeden önce bunları kontrol edip düzeltirsiniz. Onayınız olmadan hiçbir şey kaydedilmez.",
      },
      {
        id: "familie",
        title: "Aile ve haneler",
        body: "Bir haneye ortak ve kişisel hesaplarla üye davet edebilirsiniz. Herkes yalnızca rolünün izin verdiğini görür.",
      },
      {
        id: "export",
        title: "Dışa aktarma ve raporlar",
        body: "İşlemleri CSV, Excel veya PDF olarak dışa aktarın ve muhasebeciniz için bir dışa aktarma oluşturun. Aya, kategoriye ve satıcıya göre raporlar uygulamadadır.",
      },
      {
        id: "date",
        title: "Verileriniz",
        body: "Tüm verilerinizi indirebilir ve hesabınızı doğrudan Ayarlar'daki gizlilik bölümünden silebilirsiniz. Ayrıntılar gizlilik politikasındadır.",
      },
      {
        id: "parola",
        title: "Parolamı unuttum",
        body: "Giriş sayfasında, hizmet sunuyorsa parola sıfırlama seçeneğini veya e-postayla gönderilen giriş bağlantısını kullanın.",
      },
    ],
    contactTitle: "İletişim",
    contactLead: "Sorularınız veya sorunlarınız için bize şu adresten yazın:",
  },
  terms: { title: "Hükümler ve koşullar" },
  privacy: { title: "Gizlilik politikası" },
  draft: {
    title: "İnceleme aşamasındaki metin",
    body: "Bu, hukuki açıdan incelenmemiş bir çalışma taslağıdır. İşletmeci tarafından incelenip yayımlanana kadar hiçbir hüküm doğurmaz. Romence sürüm başvuru metnidir.",
    incomplete: "Hizmeti işleten şirketin bilgileri henüz doldurulmamıştır.",
    translationNote:
      "Hukuki metin İngilizce gösterilir (çalışma çevirisi); Romence sürüm başvuru metnidir.",
  },
  footer: {
    operator: "İşletmeci",
    taxId: "Vergi kimlik no (CUI)",
    registration: "Ticaret Sicili",
    address: "Adres",
    contact: "İletişim",
    missing: "doldurulacak",
    consumer: "Tüketici uyuşmazlıkları",
    anpcSal: "ANPC SAL",
    sol: "AB çevrimiçi uyuşmazlık çözümü platformu (ODR)",
  },
  consent: {
    title: "Çerezler",
    body: "Yalnızca kesinlikle gerekli çerezleri kullanıyoruz. Onayınızla, sitenin nasıl kullanıldığını anlamak için analiz çerezlerini de kullanırız. Hizmeti etkilemeden reddedebilirsiniz.",
    accept: "Analizi kabul et",
    reject: "Reddet",
    region: "Çerez tercihiniz",
  },
};
