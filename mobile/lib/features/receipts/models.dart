import '../../core/money/money.dart';
import '../../core/time/period.dart';
import '../finance/models.dart';

/// Modelele documentelor, bonurilor și potrivirilor cu extrasul (Faza D), după
/// `docs/openapi.json`. Telefonul nu citește bonurile: afișează ce a extras serverul. Sumele
/// rămân `int` în unități minore; verificările (`issues`, `linesSumMinor`) vin de la server.

enum DocumentStatus {
  uploaded('uploaded', 'Încărcat'),
  awaitingConsent('awaiting_consent', 'Așteaptă acordul pentru AI'),
  queued('queued', 'În coadă'),
  processing('processing', 'Se citește'),
  needsReview('needs_review', 'De verificat'),
  done('done', 'Salvat'),
  failed('failed', 'Eșuat'),
  rejected('rejected', 'Refuzat');

  const DocumentStatus(this.api, this.label);
  final String api;
  final String label;

  static DocumentStatus parse(String value) => DocumentStatus.values.firstWhere(
    (s) => s.api == value,
    orElse: () =>
        throw FormatException('Stare de document necunoscută: $value'),
  );

  /// Stări în care documentul încă se mișcă: ecranul îl reinterogă.
  bool get inFlight => this == uploaded || this == queued || this == processing;
}

class DocumentInfo {
  const DocumentInfo({
    required this.id,
    required this.status,
    required this.mime,
    required this.errorCode,
    required this.possibleDuplicateOfId,
    required this.receiptId,
    required this.duplicate,
    required this.createdAt,
  });

  factory DocumentInfo.fromJson(JsonMap m) => DocumentInfo(
    id: Json.str(m, 'id'),
    status: DocumentStatus.parse(Json.str(m, 'status')),
    mime: Json.str(m, 'mime'),
    errorCode: Json.strOrNull(m, 'errorCode'),
    possibleDuplicateOfId: Json.strOrNull(m, 'possibleDuplicateOfId'),
    receiptId: Json.strOrNull(m, 'receiptId'),
    duplicate: m['duplicate'] == true,
    createdAt: DateTime.parse(Json.str(m, 'createdAt')),
  );

  final String id;
  final DocumentStatus status;
  final String mime;
  final String? errorCode;
  final String? possibleDuplicateOfId;

  /// Bonul extras din document; lipsește cât timp documentul nu e citit.
  final String? receiptId;

  /// Serverul a recunoscut aceiași octeți (SHA-256): documentul există deja.
  final bool duplicate;
  final DateTime createdAt;
}

/// Răspunsul la încărcare: documentele create sau recunoscute ca duplicate.
class UploadResult {
  const UploadResult({
    required this.documents,
    required this.batchId,
    required this.created,
  });

  factory UploadResult.fromJson(JsonMap m) => UploadResult(
    documents: [
      for (final d in Json.list(m['documents'])) DocumentInfo.fromJson(d),
    ],
    batchId: Json.strOrNull(m, 'batchId'),
    created: Json.integer(m, 'created'),
  );

  final List<DocumentInfo> documents;
  final String? batchId;
  final int created;

  bool get allDuplicates => created == 0 && documents.every((d) => d.duplicate);
}

enum ReceiptStatus {
  queued('queued', 'În coadă'),
  needsReview('needs_review', 'De verificat'),
  saved('saved', 'Salvat'),
  failed('failed', 'Eșuat');

  const ReceiptStatus(this.api, this.label);
  final String api;
  final String label;

  static ReceiptStatus parse(String value) => ReceiptStatus.values.firstWhere(
    (s) => s.api == value,
    orElse: () => throw FormatException('Stare de bon necunoscută: $value'),
  );
}

enum LineKind {
  product('product', 'Produs'),
  discount('discount', 'Reducere'),
  depositSgr('deposit_sgr', 'Garanție SGR'),
  bag('bag', 'Pungă'),
  other('other', 'Altele');

  const LineKind(this.api, this.label);
  final String api;
  final String label;

  static LineKind parse(String value) => LineKind.values.firstWhere(
    (k) => k.api == value,
    orElse: () => throw FormatException('Tip de linie necunoscut: $value'),
  );
}

enum PaymentMethod {
  cash('cash', 'Numerar'),
  card('card', 'Card'),
  voucher('voucher', 'Tichete'),
  mixed('mixed', 'Mixt'),
  other('other', 'Altfel');

  const PaymentMethod(this.api, this.label);
  final String api;
  final String label;

  static PaymentMethod? parse(String? value) => value == null
      ? null
      : PaymentMethod.values.firstWhere(
          (p) => p.api == value,
          orElse: () => throw FormatException('Plată necunoscută: $value'),
        );
}

class ReceiptIssue {
  const ReceiptIssue({required this.code, this.field, this.line});

  factory ReceiptIssue.fromJson(JsonMap m) => ReceiptIssue(
    code: Json.str(m, 'code'),
    field: Json.strOrNull(m, 'field'),
    line: Json.integerOrNull(m, 'line'),
  );

  final String code;
  final String? field;
  final int? line;
}

class ReceiptLine {
  const ReceiptLine({
    required this.id,
    required this.position,
    required this.rawName,
    required this.quantity,
    required this.unitPriceMinor,
    required this.lineTotalMinor,
    required this.vatRate,
    required this.categoryId,
    required this.kind,
  });

  factory ReceiptLine.fromJson(JsonMap m) => ReceiptLine(
    id: Json.str(m, 'id'),
    position: Json.integer(m, 'position'),
    rawName: Json.str(m, 'rawName'),
    quantity: Json.strOrNull(m, 'quantity'),
    unitPriceMinor: Json.integerOrNull(m, 'unitPriceMinor'),
    lineTotalMinor: Json.integer(m, 'lineTotalMinor'),
    vatRate: Json.strOrNull(m, 'vatRate'),
    categoryId: Json.strOrNull(m, 'categoryId'),
    kind: LineKind.parse(Json.str(m, 'kind')),
  );

  final String id;
  final int position;
  final String rawName;
  final String? quantity;
  final int? unitPriceMinor;
  final int lineTotalMinor;
  final String? vatRate;
  final String? categoryId;
  final LineKind kind;
}

class RemovedLine {
  const RemovedLine({
    required this.part,
    required this.position,
    required this.name,
  });

  factory RemovedLine.fromJson(JsonMap m) => RemovedLine(
    part: Json.integer(m, 'part'),
    position: Json.integer(m, 'position'),
    name: Json.strOrNull(m, 'name'),
  );

  final int part;
  final int position;
  final String? name;
}

class Receipt {
  const Receipt({
    required this.id,
    required this.status,
    required this.documentIds,
    required this.merchantName,
    required this.merchantTaxId,
    required this.storeAddress,
    required this.receiptNumber,
    required this.occurredOn,
    required this.paymentMethod,
    required this.totalMinor,
    required this.vatTotalMinor,
    required this.currency,
    required this.confidence,
    required this.providerUsed,
    required this.fallbackReason,
    required this.transactionId,
    required this.duplicateOfReceiptId,
    required this.issues,
    required this.linesSumMinor,
    required this.lineCount,
    required this.lines,
    required this.removedLines,
    required this.removedCount,
    required this.createdAt,
  });

  factory Receipt.fromJson(JsonMap m) => Receipt(
    id: Json.str(m, 'id'),
    status: ReceiptStatus.parse(Json.str(m, 'status')),
    documentIds: [for (final d in (m['documentIds'] as List)) d as String],
    merchantName: Json.strOrNull(m, 'merchantName'),
    merchantTaxId: Json.strOrNull(m, 'merchantTaxId'),
    storeAddress: Json.strOrNull(m, 'storeAddress'),
    receiptNumber: Json.strOrNull(m, 'receiptNumber'),
    occurredOn: m['occurredOn'] == null
        ? null
        : parseApiDate(Json.str(m, 'occurredOn')),
    paymentMethod: PaymentMethod.parse(Json.strOrNull(m, 'paymentMethod')),
    totalMinor: Json.integerOrNull(m, 'totalMinor'),
    vatTotalMinor: Json.integerOrNull(m, 'vatTotalMinor'),
    currency: Json.currency(m, 'currency'),
    confidence: Json.integerOrNull(m, 'confidence'),
    providerUsed: Json.str(m, 'providerUsed'),
    fallbackReason: Json.strOrNull(m, 'fallbackReason'),
    transactionId: Json.strOrNull(m, 'transactionId'),
    duplicateOfReceiptId: Json.strOrNull(m, 'duplicateOfReceiptId'),
    issues: [for (final i in Json.list(m['issues'])) ReceiptIssue.fromJson(i)],
    linesSumMinor: Json.integerOrNull(m, 'linesSumMinor'),
    lineCount: Json.integer(m, 'lineCount'),
    lines: m['lines'] == null
        ? const []
        : [for (final l in Json.list(m['lines'])) ReceiptLine.fromJson(l)],
    removedLines: m['removedLines'] == null
        ? const []
        : [
            for (final r in Json.list(m['removedLines']))
              RemovedLine.fromJson(r),
          ],
    removedCount: m['removedCount'] is int ? m['removedCount']! as int : 0,
    createdAt: DateTime.parse(Json.str(m, 'createdAt')),
  );

  final String id;
  final ReceiptStatus status;
  final List<String> documentIds;
  final String? merchantName;
  final String? merchantTaxId;
  final String? storeAddress;
  final String? receiptNumber;
  final DateTime? occurredOn;
  final PaymentMethod? paymentMethod;
  final int? totalMinor;
  final int? vatTotalMinor;
  final Currency currency;
  final int? confidence;

  /// `none`, `local` sau `external`: cine a citit bonul (promptul Android §10).
  final String providerUsed;
  final String? fallbackReason;
  final String? transactionId;
  final String? duplicateOfReceiptId;
  final List<ReceiptIssue> issues;

  /// Suma liniilor, calculată de server.
  final int? linesSumMinor;
  final int lineCount;
  final List<ReceiptLine> lines;
  final List<RemovedLine> removedLines;
  final int removedCount;
  final DateTime createdAt;

  Money? get total => totalMinor == null ? null : Money(totalMinor!, currency);
  Money? get linesSum =>
      linesSumMinor == null ? null : Money(linesSumMinor!, currency);
  Money? get vatTotal =>
      vatTotalMinor == null ? null : Money(vatTotalMinor!, currency);
}

class ReceiptPage {
  const ReceiptPage({required this.items, required this.nextCursor});

  final List<Receipt> items;
  final String? nextCursor;
}

class MatchCandidate {
  const MatchCandidate({
    required this.transactionId,
    required this.accountId,
    required this.occurredOn,
    required this.amount,
    required this.description,
    required this.probable,
    required this.reasons,
  });

  factory MatchCandidate.fromJson(JsonMap m) => MatchCandidate(
    transactionId: Json.str(m, 'transactionId'),
    accountId: Json.str(m, 'accountId'),
    occurredOn: parseApiDate(Json.str(m, 'occurredOn'))!,
    amount: Money(Json.integer(m, 'amountMinor'), Json.currency(m, 'currency')),
    description: Json.strOrNull(m, 'description'),
    probable: Json.boolean(m, 'probable'),
    reasons: [for (final r in (m['reasons'] as List)) r as String],
  );

  final String transactionId;
  final String accountId;
  final DateTime occurredOn;
  final Money amount;
  final String? description;
  final bool probable;
  final List<String> reasons;
}

/// Potrivirile propuse pentru un bon: tranzacții din extras cu aceeași sumă, ±3 zile.
class ReceiptMatches {
  const ReceiptMatches({
    required this.receiptId,
    required this.merchantName,
    required this.occurredOn,
    required this.total,
    required this.ambiguous,
    required this.candidates,
  });

  factory ReceiptMatches.fromJson(JsonMap m) => ReceiptMatches(
    receiptId: Json.str(m, 'receiptId'),
    merchantName: Json.strOrNull(m, 'merchantName'),
    occurredOn: parseApiDate(Json.str(m, 'occurredOn'))!,
    total: Money(Json.integer(m, 'totalMinor'), Json.currency(m, 'currency')),
    ambiguous: Json.boolean(m, 'ambiguous'),
    candidates: [
      for (final c in Json.list(m['candidates'])) MatchCandidate.fromJson(c),
    ],
  );

  final String receiptId;
  final String? merchantName;
  final DateTime occurredOn;
  final Money total;
  final bool ambiguous;
  final List<MatchCandidate> candidates;
}

/// Decizia asupra unei propuneri: legarea bonului (fără tranzacție nouă) sau respingerea ei.
class MatchDecisionResult {
  const MatchDecisionResult({required this.removedTransactionId});

  factory MatchDecisionResult.fromJson(JsonMap m) => MatchDecisionResult(
    removedTransactionId: Json.strOrNull(m, 'removedTransactionId'),
  );

  /// Tranzacția dublură pe care serverul a scos-o la legare.
  final String? removedTransactionId;
}

/// „X din Y documente azi”, de la server.
class AiUsage {
  const AiUsage({
    required this.used,
    required this.limit,
    required this.remaining,
  });

  factory AiUsage.fromJson(JsonMap m) => AiUsage(
    used: Json.integer(m, 'used'),
    limit: Json.integer(m, 'limit'),
    remaining: Json.integer(m, 'remaining'),
  );

  final int used;
  final int limit;
  final int remaining;
}
