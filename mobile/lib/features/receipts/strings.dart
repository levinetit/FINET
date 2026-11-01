import '../../core/network/api_error.dart';
import 'models.dart';

/// Textele pentru coduri stabile, aceleași ca pe web (`src/messages/ro.ts`), ca bonul să se
/// citească la fel în ambele aplicații.

const Map<String, String> _documentErrors = {
  'unsupported_media_type': 'Cererea nu a putut fi trimisă. Încearcă din nou.',
  'payload_too_large': 'Fișierele sunt prea mari împreună.',
  'file_too_large': 'Un fișier depășește dimensiunea maximă.',
  'too_many_files': 'Cel mult 4 fișiere o dată.',
  'no_files': 'Alege cel puțin un fișier.',
  'invalid_multipart': 'Încărcarea s-a întrerupt. Încearcă din nou.',
  'invalid_field': 'Cererea conține câmpuri nepermise.',
  'empty_file': 'Un fișier e gol.',
  'unsupported_type':
      'Tip de fișier neacceptat. Se acceptă JPEG, PNG, WebP și PDF.',
  'heic_unsupported': 'Pozele HEIC/HEIF nu sunt acceptate de server. Aplicația le convertește singură în JPEG; încearcă din nou.',
  'markup_content': 'Fișierul conține cod sau marcaje și nu e acceptat.',
  'invalid_image': 'Imaginea nu poate fi citită.',
  'image_too_large': 'Imaginea are prea mulți pixeli.',
  'mime_mismatch': 'Conținutul fișierului nu corespunde tipului lui.',
  'too_many_pages': 'PDF-ul are prea multe pagini.',
  'pdf_invalid': 'PDF-ul nu poate fi citit.',
  'pdf_encrypted': 'PDF-ul e protejat cu parolă.',
  'pdf_no_content': 'PDF-ul nu conține nici text, nici imagini.',
  'pdf_image_unverifiable':
      'PDF-ul are o structură care nu poate fi verificată.',
  'pdf_too_complex': 'PDF-ul e prea complex.',
  'pdf_sandbox_unavailable': 'PDF-urile nu pot fi citite momentan.',
  'preprocess_timeout': 'Fișierul a durat prea mult de pregătit.',
  'file_missing': 'Fișierul nu mai există.',
  'file_changed': 'Fișierul s-a schimbat după încărcare.',
};

/// Motivul pentru care un document a eșuat sau a fost refuzat (`documents.errorCode`).
String documentErrorText(String? code) =>
    _documentErrors[code] ?? 'Încărcarea nu a reușit. Încearcă din nou.';

/// Mesajul pentru o eroare de încărcare: codul stabil al serverului, apoi mesajul lui.
String uploadErrorText(ApiError e) {
  switch (e.code) {
    case 'daily_document_limit':
      return 'Ai atins limita zilnică de documente. Încearcă mâine.';
    case 'storage_quota_exceeded':
      return 'Spațiul de stocare al gospodăriei este plin.';
    case 'long_receipt_duplicate':
      return 'Una dintre poze a fost deja încărcată ca bon separat.';
    case 'statement_daily_limit':
      return 'Ai atins limita zilnică de extrase. Încearcă mâine.';
    case 'account_archived':
      return 'Contul este arhivat.';
    case 'owner_mismatch':
      return 'Contul sau gospodăria s-au schimbat. Deschide din nou aplicația.';
  }
  if (e.status == 413) return _documentErrors['file_too_large']!;
  if (e.status == 415) {
    return _documentErrors[e.code] ?? _documentErrors['unsupported_type']!;
  }
  if (e.kind == ApiErrorKind.rateLimited) {
    return 'Prea multe încărcări într-un timp scurt. Încearcă peste câteva minute.';
  }
  return _documentErrors[e.code] ?? e.message;
}

const Map<String, String> _issueText = {
  'extraction_failed':
      'Bonul nu a putut fi citit automat; completează câmpurile.',
  'ai_unavailable':
      'Serviciul AI nu e configurat; completează câmpurile manual.',
  'budget_exceeded':
      'Bugetul lunar AI a fost atins; completează câmpurile manual.',
  'consent_missing':
      'Acordul pentru AI a fost retras; completează câmpurile manual.',
  'lines_missing': 'Bonul nu are produse.',
  'total_missing': 'Lipsește totalul.',
  'total_mismatch': 'Suma liniilor nu se potrivește cu totalul.',
  'merchant_missing': 'Lipsește magazinul.',
  'tax_id_missing': 'Lipsește CUI-ul.',
  'tax_id_invalid': 'CUI-ul nu e valid (cifra de control).',
  'date_missing': 'Lipsește data.',
  'date_in_future': 'Data e în viitor.',
  'date_too_old': 'Data e mai veche de 5 ani.',
  'vat_rate_unknown': 'Cota de TVA nu era valabilă la data bonului.',
  'vat_total_implausible': 'TVA-ul total nu se potrivește cu liniile.',
  'quantity_invalid': 'Cantitatea nu e validă.',
  'line_amount_mismatch': 'Cantitate × preț ≠ totalul liniei.',
  'sgr_amount_invalid': 'Garanția SGR nu e un multiplu de 0,50 lei.',
  'low_confidence': 'Încredere scăzută: verifică toate câmpurile.',
  'duplicate_receipt': 'Același bon pare să fi fost încărcat deja.',
  'long_receipt_order': 'Pozele bonului lung sunt în altă ordine.',
  'long_receipt_mismatch':
      'Pozele bonului lung par să fie de la bonuri diferite.',
  'possible_duplicate_image': 'O poză aproape identică a mai fost încărcată.',
  'too_many_lines': 'Bonul are prea multe linii; s-au păstrat primele 500.',
};

String issueText(ReceiptIssue issue) {
  final base = _issueText[issue.code] ?? 'Verifică bonul (${issue.code}).';
  final line = issue.line;
  return line == null ? base : '$base (linia $line)';
}

/// Cine a citit bonul (promptul Android §10: local sau cu furnizorul extern).
String providerText(String provider) => switch (provider) {
  'local' => 'Citit cu modelul local.',
  'external' => 'Citit cu serviciul AI extern (Google, prin LiteLLM).',
  _ => 'Bonul nu a fost citit automat.',
};

const Map<String, String> _fallback = {
  'no_local_model': 'nu există încă un model local',
  'local_unavailable': 'modelul local nu e disponibil',
  'local_timeout': 'modelul local a răspuns prea greu',
  'local_failed_validation': 'modelul local a dat un răspuns invalid',
  'low_confidence': 'încredere scăzută la modelul local',
  'consent_missing': 'lipsește acordul pentru AI extern',
  'budget_exceeded': 'bugetul lunar AI a fost atins',
  'daily_limit': 'limita zilnică a fost atinsă',
  'external_failed': 'serviciul AI extern nu a răspuns corect',
  'ai_unconfigured': 'serviciul AI nu e configurat',
};

String? fallbackText(String? reason) =>
    reason == null ? null : 'Motiv: ${_fallback[reason] ?? reason}';
