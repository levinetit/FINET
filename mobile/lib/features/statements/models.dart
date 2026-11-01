import '../../core/money/money.dart';
import '../../core/time/period.dart';
import '../finance/models.dart';

/// Modelele extraselor bancare (Faza D), după `docs/openapi.json`. Soldurile, duplicatele și
/// verificările de sold le calculează serverul; telefonul afișează rezultatul.

enum ImportStatus {
  previewed('previewed', 'De confirmat'),
  imported('imported', 'Importat'),
  failed('failed', 'Eșuat'),
  cancelled('cancelled', 'Anulat');

  const ImportStatus(this.api, this.label);
  final String api;
  final String label;

  static ImportStatus parse(String v) => ImportStatus.values.firstWhere(
    (s) => s.api == v,
    orElse: () => throw FormatException('Stare de import necunoscută: $v'),
  );
}

enum LineState {
  fresh('new', 'Nou'),
  duplicate('duplicate', 'Duplicat'),
  imported('imported', 'Importat'),
  skipped('skipped', 'Sărit'),
  cancelled('cancelled', 'Anulat');

  const LineState(this.api, this.label);
  final String api;
  final String label;

  static LineState parse(String v) => LineState.values.firstWhere(
    (s) => s.api == v,
    orElse: () => throw FormatException('Stare de rând necunoscută: $v'),
  );
}

class StatementLine {
  const StatementLine({
    required this.rowNo,
    required this.occurredOn,
    required this.credit,
    required this.amount,
    required this.description,
    required this.isFx,
    required this.fxAmount,
    required this.state,
  });

  factory StatementLine.fromJson(JsonMap m, Currency currency) {
    final fxMinor = Json.integerOrNull(m, 'fxAmountMinor');
    final fxCurrency = m['fxCurrency'] == null
        ? null
        : Json.currency(m, 'fxCurrency');
    return StatementLine(
      rowNo: Json.integer(m, 'rowNo'),
      occurredOn: parseApiDate(Json.str(m, 'occurredOn'))!,
      credit: Json.str(m, 'direction') == 'credit',
      amount: Money(Json.integer(m, 'amountMinor'), currency),
      description: Json.str(m, 'description'),
      isFx: Json.str(m, 'kind') == 'fx',
      fxAmount: fxMinor == null || fxCurrency == null
          ? null
          : Money(fxMinor, fxCurrency),
      state: LineState.parse(Json.str(m, 'state')),
    );
  }

  final int rowNo;
  final DateTime occurredOn;

  /// `true` = intrare de bani (credit), `false` = ieșire (debit).
  final bool credit;
  final Money amount;
  final String description;

  /// Schimb valutar: cere o decizie explicită la confirmare.
  final bool isFx;
  final Money? fxAmount;
  final LineState state;
}

class StatementImport {
  const StatementImport({
    required this.id,
    required this.accountId,
    required this.currency,
    required this.bank,
    required this.format,
    required this.status,
    required this.periodStart,
    required this.periodEnd,
    required this.openingBalance,
    required this.closingBalance,
    required this.computedClosing,
    required this.balanceStatus,
    required this.lineCount,
    required this.newCount,
    required this.duplicateCount,
    required this.importedCount,
    required this.warnings,
    required this.lines,
  });

  factory StatementImport.fromJson(JsonMap m) {
    final currency = Json.currency(m, 'currency');
    Money? money(String key) {
      final v = Json.integerOrNull(m, key);
      return v == null ? null : Money(v, currency);
    }

    DateTime? date(String key) =>
        m[key] == null ? null : parseApiDate(Json.str(m, key));
    return StatementImport(
      id: Json.str(m, 'id'),
      accountId: Json.str(m, 'accountId'),
      currency: currency,
      bank: Json.str(m, 'bank'),
      format: Json.str(m, 'format'),
      status: ImportStatus.parse(Json.str(m, 'status')),
      periodStart: date('periodStart'),
      periodEnd: date('periodEnd'),
      openingBalance: money('openingBalanceMinor'),
      closingBalance: money('closingBalanceMinor'),
      computedClosing: money('computedClosingMinor'),
      balanceStatus: Json.str(m, 'balanceStatus'),
      lineCount: Json.integer(m, 'lineCount'),
      newCount: Json.integer(m, 'newCount'),
      duplicateCount: Json.integer(m, 'duplicateCount'),
      importedCount: Json.integer(m, 'importedCount'),
      warnings: [for (final w in (m['warnings'] as List)) w as String],
      lines: m['lines'] == null
          ? const []
          : [
              for (final l in Json.list(m['lines']))
                StatementLine.fromJson(l, currency),
            ],
    );
  }

  final String id;
  final String accountId;
  final Currency currency;
  final String bank;
  final String format;
  final ImportStatus status;
  final DateTime? periodStart;
  final DateTime? periodEnd;
  final Money? openingBalance;
  final Money? closingBalance;
  final Money? computedClosing;

  /// `ok`, `mismatch` sau `unknown`, decis de server.
  final String balanceStatus;
  final int lineCount;
  final int newCount;
  final int duplicateCount;
  final int importedCount;
  final List<String> warnings;
  final List<StatementLine> lines;

  bool get balanceMismatch => balanceStatus == 'mismatch';
  List<StatementLine> get fxLines => [
    for (final l in lines)
      if (l.isFx && l.state == LineState.fresh) l,
  ];
}

class StatementUpload {
  const StatementUpload({
    required this.id,
    required this.status,
    required this.errorCode,
    required this.importId,
  });

  factory StatementUpload.fromJson(JsonMap m) => StatementUpload(
    id: Json.str(m, 'id'),
    status: Json.str(m, 'status'),
    errorCode: Json.strOrNull(m, 'errorCode'),
    importId: Json.strOrNull(m, 'importId'),
  );

  final String id;

  /// `queued`, `processing`, `parsed` sau `failed`.
  final String status;
  final String? errorCode;
  final String? importId;

  bool get inFlight => status == 'queued' || status == 'processing';
}

/// Rezultatul pentru un fișier încărcat: în coadă (PDF), previzualizare, asociere de coloane
/// necesară (CSV/XLSX necunoscut) sau respins (necitibil dintr-un ZIP).
sealed class UploadPart {
  const UploadPart();

  factory UploadPart.fromJson(JsonMap m) {
    switch (Json.str(m, 'kind')) {
      case 'queued':
        return QueuedPart(StatementUpload.fromJson(Json.map(m['upload'])));
      case 'preview':
        return PreviewPart(
          StatementImport.fromJson(Json.map(m['import'])),
          alreadyImported: m['alreadyImported'] == true,
        );
      case 'mapping_required':
        return const MappingRequiredPart();
      case 'rejected':
        return RejectedPart(Json.strOrNull(m, 'code'));
      default:
        throw const FormatException('Rezultat de încărcare necunoscut.');
    }
  }
}

class QueuedPart extends UploadPart {
  const QueuedPart(this.upload);
  final StatementUpload upload;
}

class PreviewPart extends UploadPart {
  const PreviewPart(this.import, {required this.alreadyImported});
  final StatementImport import;
  final bool alreadyImported;
}

class MappingRequiredPart extends UploadPart {
  const MappingRequiredPart();
}

class RejectedPart extends UploadPart {
  const RejectedPart(this.code);
  final String? code;
}

class CoverageMonth {
  const CoverageMonth({
    required this.month,
    required this.status,
    required this.coveredUntil,
  });

  factory CoverageMonth.fromJson(JsonMap m) => CoverageMonth(
    month: Json.str(m, 'month'),
    status: Json.str(m, 'status'),
    coveredUntil: m['coveredUntil'] == null
        ? null
        : parseApiDate(Json.str(m, 'coveredUntil')),
  );

  /// `AAAA-LL`.
  final String month;

  /// `complete`, `partial` sau `missing`.
  final String status;
  final DateTime? coveredUntil;
}

class AccountCoverage {
  const AccountCoverage({
    required this.accountId,
    required this.accountName,
    required this.currency,
    required this.months,
    required this.missingMonths,
  });

  factory AccountCoverage.fromJson(JsonMap m) => AccountCoverage(
    accountId: Json.str(m, 'accountId'),
    accountName: Json.str(m, 'accountName'),
    currency: Json.currency(m, 'currency'),
    months: [for (final c in Json.list(m['months'])) CoverageMonth.fromJson(c)],
    missingMonths: [for (final x in (m['missingMonths'] as List)) x as String],
  );

  final String accountId;
  final String accountName;
  final Currency currency;
  final List<CoverageMonth> months;
  final List<String> missingMonths;
}
