import type { SiteMessages } from "./en-site";

/**
 * Textes des PAGES PUBLIQUES du site `saas` en français (Phase 13, ADR 0033). Traduction de travail
 * du texte anglais ; la forme est imposée par le type `SiteMessages` et un test vérifie qu'aucune
 * clé ne manque. Le roumain reste la version de référence.
 */
export const frSite: SiteMessages = {
  nav: {
    pricing: "Tarifs",
    terms: "Conditions",
    privacy: "Confidentialité",
    support: "Assistance",
    login: "Se connecter",
    register: "Créer un compte",
    language: "Langue",
    skip: "Aller au contenu",
  },
  landing: {
    title: "FINET : vos finances et celles de votre famille, au même endroit",
    lead: "Suivez vos comptes, vos dépenses et vos budgets, scannez vos tickets et voyez où va l'argent.",
    features: [
      "Tickets lus à partir d'une photo ou d'un PDF, avec votre vérification avant l'enregistrement",
      "Budgets, objectifs et rapports par mois, catégorie et commerçant",
      "Famille : comptes partagés et personnels, soldes et remboursements",
      "Relevés bancaires, listes de courses et prix par produit",
      "Export en CSV, Excel et PDF, ainsi qu'un export pour votre comptable",
      "Vos données sous votre contrôle : exportez et supprimez directement depuis l'application",
    ],
    cta: "Créer un compte",
    secondary: "Vous avez déjà un compte ? Connectez-vous",
  },
  pricing: {
    title: "Tarifs",
    body: "Les formules et les tarifs seront publiés ici lors de leur lancement. D'ici là, le service ne propose pas encore de formule payante.",
  },
  support: {
    title: "Assistance",
    lead: "De courtes réponses sur l'utilisation de FINET. Si vous ne trouvez pas ce dont vous avez besoin, écrivez-nous.",
    sections: [
      {
        id: "inceput",
        title: "Comment démarrer ?",
        body: "Créez votre compte avec votre adresse e-mail, puis ajoutez vos comptes (espèces, banque, carte) et vos premières transactions. Chaque nouveau compte reçoit un foyer personnel que vous pourrez élargir plus tard.",
      },
      {
        id: "bonuri",
        title: "Tickets de caisse",
        body: "Envoyez une photo ou un PDF d'un ticket ; FINET propose les données lues, que vous vérifiez et corrigez avant d'enregistrer. Rien n'est enregistré sans votre confirmation.",
      },
      {
        id: "familie",
        title: "Famille et foyers",
        body: "Vous pouvez inviter des membres dans un foyer, avec des comptes partagés et personnels. Chacun ne voit que ce que son rôle autorise.",
      },
      {
        id: "export",
        title: "Export et rapports",
        body: "Exportez les transactions en CSV, Excel ou PDF et générez un export pour votre comptable. Les rapports par mois, catégorie et commerçant sont dans l'application.",
      },
      {
        id: "date",
        title: "Vos données",
        body: "Vous pouvez télécharger toutes vos données et supprimer votre compte directement depuis les Paramètres, dans la section confidentialité. Les détails figurent dans la politique de confidentialité.",
      },
      {
        id: "parola",
        title: "J'ai oublié mon mot de passe",
        body: "Sur la page de connexion, utilisez l'option de réinitialisation du mot de passe ou le lien de connexion envoyé par e-mail, si le service le propose.",
      },
    ],
    contactTitle: "Contact",
    contactLead: "Pour toute question ou tout problème, écrivez-nous à",
  },
  terms: { title: "Conditions générales" },
  privacy: { title: "Politique de confidentialité" },
  draft: {
    title: "Texte en cours de révision",
    body: "Ceci est un projet de travail, non révisé juridiquement. Il ne produit aucun effet tant qu'il n'a pas été révisé et publié par l'opérateur. La version roumaine est le texte de référence.",
    incomplete:
      "Les informations de l'entreprise qui exploite le service ne sont pas encore renseignées.",
    translationNote:
      "Le texte juridique est affiché en anglais (traduction de travail) ; la version roumaine est le texte de référence.",
  },
  footer: {
    operator: "Opérateur",
    taxId: "Identifiant fiscal (CUI)",
    registration: "Registre du commerce",
    address: "Adresse",
    contact: "Contact",
    missing: "à compléter",
    consumer: "Litiges de consommation",
    anpcSal: "ANPC SAL",
    sol: "Plateforme européenne de règlement en ligne des litiges (RLL)",
  },
  consent: {
    title: "Cookies",
    body: "Nous utilisons des cookies strictement nécessaires. Avec votre accord, nous utilisons aussi des cookies d'analyse pour comprendre comment le site est utilisé. Vous pouvez refuser sans conséquence pour le service.",
    accept: "Accepter l'analyse",
    reject: "Refuser",
    region: "Votre choix concernant les cookies",
  },
};
