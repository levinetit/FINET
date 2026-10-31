import type { SiteMessages } from "./en-site";

/**
 * Textos de las PÁGINAS PÚBLICAS del sitio `saas` en español (Fase 13, ADR 0033). Traducción de
 * trabajo del texto en inglés; la forma la impone el tipo `SiteMessages` y un test comprueba que
 * no falte ninguna clave. El rumano sigue siendo la versión de referencia.
 */
export const esSite: SiteMessages = {
  nav: {
    pricing: "Precios",
    terms: "Términos",
    privacy: "Privacidad",
    support: "Soporte",
    login: "Iniciar sesión",
    register: "Crear cuenta",
    language: "Idioma",
    skip: "Saltar al contenido",
  },
  landing: {
    title: "FINET: tus finanzas y las de tu familia, en un solo lugar",
    lead: "Controla cuentas, gastos y presupuestos, escanea recibos y descubre adónde va el dinero.",
    features: [
      "Recibos leídos desde una foto o un PDF, con tu revisión antes de guardar",
      "Presupuestos, objetivos e informes por mes, categoría y comercio",
      "Familia: cuentas compartidas y personales, saldos y liquidaciones",
      "Extractos bancarios, listas de la compra y precios por producto",
      "Exportación a CSV, Excel y PDF, y una exportación para tu gestor",
      "Tus datos bajo tu control: exporta y elimina directamente desde la aplicación",
    ],
    cta: "Crear cuenta",
    secondary: "¿Ya tienes una cuenta? Inicia sesión",
  },
  pricing: {
    title: "Precios",
    body: "Los planes y los precios se publicarán aquí cuando se lancen. Hasta entonces, el servicio aún no tiene planes de pago.",
  },
  support: {
    title: "Soporte",
    lead: "Respuestas breves sobre el uso de FINET. Si no encuentras lo que buscas, escríbenos.",
    sections: [
      {
        id: "inceput",
        title: "¿Cómo empiezo?",
        body: "Crea tu cuenta con tu correo electrónico, añade tus cuentas (efectivo, banco, tarjeta) y tus primeras transacciones. Cada cuenta nueva recibe un hogar personal que puedes ampliar más adelante.",
      },
      {
        id: "bonuri",
        title: "Recibos",
        body: "Sube una foto o un PDF de un recibo; FINET propone los datos que ha leído y tú los revisas y corriges antes de guardar. No se guarda nada sin tu confirmación.",
      },
      {
        id: "familie",
        title: "Familia y hogares",
        body: "Puedes invitar a miembros a un hogar, con cuentas compartidas y personales. Cada persona ve solo lo que permite su rol.",
      },
      {
        id: "export",
        title: "Exportación e informes",
        body: "Exporta las transacciones a CSV, Excel o PDF y genera una exportación para tu gestor. Los informes por mes, categoría y comercio están en la aplicación.",
      },
      {
        id: "date",
        title: "Tus datos",
        body: "Puedes descargar todos tus datos y eliminar tu cuenta directamente desde Ajustes, en la sección de privacidad. Los detalles están en la política de privacidad.",
      },
      {
        id: "parola",
        title: "He olvidado mi contraseña",
        body: "En la página de inicio de sesión, usa la opción de restablecer la contraseña o el enlace de acceso enviado por correo, si el servicio lo ofrece.",
      },
    ],
    contactTitle: "Contacto",
    contactLead: "Para preguntas o problemas, escríbenos a",
  },
  terms: { title: "Términos y condiciones" },
  privacy: { title: "Política de privacidad" },
  draft: {
    title: "Texto en revisión",
    body: "Este es un borrador de trabajo sin revisión jurídica. No tiene efecto hasta que el operador lo revise y lo publique. La versión en rumano es el texto de referencia.",
    incomplete: "Los datos de la empresa que opera el servicio aún no se han completado.",
    translationNote:
      "El texto jurídico se muestra en inglés (traducción de trabajo); la versión en rumano es el texto de referencia.",
  },
  footer: {
    operator: "Operador",
    taxId: "Identificación fiscal (CUI)",
    registration: "Registro Mercantil",
    address: "Dirección",
    contact: "Contacto",
    missing: "pendiente de completar",
    consumer: "Litigios de consumo",
    anpcSal: "ANPC SAL",
    sol: "Plataforma europea de resolución de litigios en línea (ODR)",
  },
  consent: {
    title: "Cookies",
    body: "Usamos cookies estrictamente necesarias. Con tu consentimiento, también usamos cookies de analítica para entender cómo se usa el sitio. Puedes rechazarlas sin que afecte al servicio.",
    accept: "Aceptar analítica",
    reject: "Rechazar",
    region: "Tu elección sobre las cookies",
  },
};
