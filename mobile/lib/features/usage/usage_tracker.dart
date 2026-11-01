import 'dart:async';

import '../../core/network/api_error.dart';

/// Un eveniment de utilizare (promptul Android §10.1). Are DOAR câmpurile de mai jos: numele
/// (dintr-o listă fixă), ecranul, codul erorii (valori fixe) și momentul. Niciodată sume,
/// descrieri, comercianți, categorii, căutări sau coordonate.
class UsageEvent {
  const UsageEvent(this.name, this.occurredAt, {this.screen, this.errorCode});

  final String name;
  final DateTime occurredAt;
  final String? screen;
  final String? errorCode;

  Map<String, Object> toJson() => {
    'name': name,
    'occurredAt': occurredAt.toUtc().toIso8601String(),
    'screen': ?screen,
    'errorCode': ?errorCode,
  };
}

/// Numele de evenimente pe care clientul le emite în Faza B (subset al listei serverului).
abstract final class UsageEvents {
  static const appOpen = 'app_open';
  static const login = 'login';
  static const logout = 'logout';
  static const sessionExpired = 'session_expired';
  static const screenView = 'screen_view';
  static const errorShown = 'error_shown';
  static const dashboardViewed = 'dashboard_viewed';
  static const reportViewed = 'report_viewed';
  static const transactionCreated = 'transaction_created';
  static const goalContributionAdded = 'goal_contribution_added';
  static const recurringGenerated = 'recurring_generated';
  static const receiptScanStarted = 'receipt_scan_started';
  static const receiptUploaded = 'receipt_uploaded';
  static const receiptConfirmed = 'receipt_confirmed';
  static const statementImported = 'statement_imported';
  static const shareImport = 'share_import';
  static const updatePromptShown = 'update_prompt_shown';
  static const updateStarted = 'update_started';
}

/// Ecranele acceptate de server pentru `screen_view` (subset folosit acum).
abstract final class UsageScreens {
  static const login = 'login';
  static const onboarding = 'onboarding';
  static const dashboard = 'dashboard';
  static const transactions = 'transactions';
  static const scan = 'scan';
  static const reports = 'reports';
  static const settings = 'settings';
  static const profile = 'profile';
  static const transactionEdit = 'transaction_edit';
  static const budgets = 'budgets';
  static const goals = 'goals';
  static const recurring = 'recurring';
  static const receipts = 'receipts';
  static const statements = 'statements';
  static const update = 'update';
}

/// Coada locală de evenimente: mică (cel mult [maxQueue]), în memorie, trimisă în loturi de cel
/// mult [batchSize]. Se pierde fără erori vizibile dacă serverul nu răspunde și nu blochează
/// niciodată interfața. Cât timp [enabled] e `false`, nu se înregistrează nimic.
class UsageTracker {
  UsageTracker({
    required this.send,
    this.enabled = false,
    this.signedIn = false,
    this.maxQueue = 300,
    this.batchSize = 20,
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  /// Trimite un lot; aruncă [ApiError] dacă nu reușește.
  final Future<void> Function(List<Map<String, Object>> events) send;
  final int maxQueue;
  final int batchSize;
  final DateTime Function() _now;

  bool enabled;

  /// Există o sesiune. Fără sesiune evenimentele nu s-ar putea trimite, deci nu se înregistrează
  /// (o ieșire din cont nu lasă nimic în coadă). Excepția: `session_expired`, înregistrat chiar în
  /// clipa expirării, când sesiunea mai e considerată activă.
  bool signedIn;
  final List<UsageEvent> _queue = [];
  bool _flushing = false;

  int get pending => _queue.length;

  List<UsageEvent> get queued => List.unmodifiable(_queue);

  void track(String name, {String? screen, String? errorCode}) {
    if (!enabled || !signedIn) return;
    if (_queue.length >= maxQueue) _queue.removeAt(0);
    _queue.add(UsageEvent(name, _now(), screen: screen, errorCode: errorCode));
  }

  void screen(String screen) => track(UsageEvents.screenView, screen: screen);

  void error(ApiError e) =>
      track(UsageEvents.errorShown, errorCode: e.analyticsCode);

  /// Trimite tot ce e în coadă, în loturi. Se oprește la prima eroare (evenimentele rămase se
  /// încearcă la următorul apel). Un 400 sau 403 înseamnă că serverul nu le primește (de exemplu
  /// fără consimțământ): lotul se aruncă, ca să nu se repete la nesfârșit.
  Future<void> flush() async {
    if (_flushing || !enabled || !signedIn) return;
    _flushing = true;
    try {
      while (_queue.isNotEmpty) {
        final batch = _queue.take(batchSize).toList();
        try {
          await send([for (final e in batch) e.toJson()]);
        } on ApiError catch (e) {
          if (e.status == 400 || e.status == 403) {
            _queue.removeWhere(batch.contains);
            continue;
          }
          return;
        } on Object {
          return;
        }
        // Coada se poate schimba în timpul trimiterii (logout, plafon): scoatem doar lotul.
        _queue.removeWhere(batch.contains);
      }
    } finally {
      _flushing = false;
    }
  }

  /// Golește coada. La expirarea sesiunii se păstrează doar `session_expired` (cere să fie
  /// raportat după următoarea autentificare); la logout se șterge tot.
  void clear({bool keepSessionExpired = false}) {
    if (keepSessionExpired) {
      _queue.removeWhere((e) => e.name != UsageEvents.sessionExpired);
    } else {
      _queue.clear();
    }
  }
}
