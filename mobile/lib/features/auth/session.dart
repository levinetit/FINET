import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/api_error.dart';
import '../../core/providers.dart';
import '../../core/state/privacy.dart';
import '../../core/storage/key_value_store.dart';
import '../settings/settings_controller.dart';
import '../usage/usage_tracker.dart';
import 'models.dart';

/// Starea sesiunii (promptul Android §6, Faza B).
sealed class SessionState {
  const SessionState();
}

/// Se verifică tokenul păstrat, la pornire.
class SessionLoading extends SessionState {
  const SessionLoading();
}

/// Fără sesiune. [notice] explică de ce (de exemplu „Sesiunea a expirat”).
class SignedOut extends SessionState {
  const SignedOut({this.notice});
  final String? notice;
}

class SignedIn extends SessionState {
  const SignedIn(this.profile);
  final Profile profile;
}

/// Există token, dar serverul nu a putut fi contactat: nu cerem parola din nou (tokenul poate fi
/// valid), arătăm eroarea și o reîncercare.
class SessionUnavailable extends SessionState {
  const SessionUnavailable(this.error);
  final ApiError error;
}

const String sessionExpiredNotice =
    'Sesiunea a expirat. Autentifică-te din nou.';

final sessionProvider = NotifierProvider<SessionController, SessionState>(
  SessionController.new,
);

class SessionController extends Notifier<SessionState> {
  @override
  SessionState build() {
    // Pornește verificarea după construirea stării inițiale.
    Future<void>.microtask(restore);
    return const SessionLoading();
  }

  /// Citește tokenul din stocarea securizată și îl verifică la server (`GET /api/v1/me`).
  Future<void> restore() async {
    state = const SessionLoading();
    final token = await ref
        .read(keyValueStoreProvider)
        .read(StoreKeys.sessionToken);
    if (token == null || token.isEmpty) {
      state = const SignedOut();
      return;
    }
    ref.read(tokenHolderProvider).value = token;
    try {
      final profile = await ref.read(authApiProvider).me();
      state = SignedIn(profile);
      ref.read(usageTrackerProvider)
        ..signedIn = true
        ..track(UsageEvents.appOpen);
      unawaited(_afterSignIn());
    } on ApiError catch (e) {
      // 401: interceptorul a apelat deja `expire()` și starea e `SignedOut`.
      if (state is! SignedOut) state = SessionUnavailable(e);
    }
  }

  /// Autentificare cu emailul și parola. Aruncă [ApiError] (mesaj în română) la eșec; în acel
  /// caz nu rămâne niciun token.
  Future<void> login(String email, String password) async {
    final token = await ref.read(authApiProvider).login(email, password);
    ref.read(tokenHolderProvider).value = token;
    try {
      final profile = await ref.read(authApiProvider).me();
      await ref
          .read(keyValueStoreProvider)
          .write(StoreKeys.sessionToken, token);
      state = SignedIn(profile);
    } on Object {
      await _wipeLocal();
      rethrow;
    }
    ref.read(usageTrackerProvider)
      ..signedIn = true
      ..track(UsageEvents.login)
      ..track(UsageEvents.appOpen);
    unawaited(_afterSignIn());
  }

  /// Deconectare: raportează `logout`, revocă sesiunea pe server (cât se poate), apoi șterge tot ce
  /// ține de sesiune de pe telefon. Pe server revocarea e „best effort”: fără rețea, telefonul
  /// tot se deconectează (tokenul e șters), iar sesiunea expiră singură pe server.
  Future<void> logout() async {
    final tracker = ref.read(usageTrackerProvider)..track(UsageEvents.logout);
    try {
      await tracker.flush().timeout(const Duration(seconds: 3));
    } on Object {
      // Statisticile nu blochează deconectarea.
    }
    try {
      await ref
          .read(authApiProvider)
          .logout()
          .timeout(const Duration(seconds: 5));
    } on Object {
      // Vezi mai sus.
    }
    await _wipeLocal();
    state = const SignedOut();
  }

  /// Apelată de interceptor la 401 pe o cerere cu token: sesiunea a expirat sau a fost revocată.
  /// Șterge datele locale și duce la login, cu o explicație. `session_expired` rămâne în coadă și
  /// se trimite după următoarea autentificare.
  void expire() {
    if (state is SignedOut) return;
    ref.read(usageTrackerProvider).track(UsageEvents.sessionExpired);
    state = const SignedOut(notice: sessionExpiredNotice);
    unawaited(_wipeLocal(keepSessionExpired: true));
  }

  /// Schimbă gospodăria activă și reîncarcă profilul.
  Future<void> switchHousehold(String householdId) async {
    final api = ref.read(authApiProvider);
    await api.setActiveHousehold(householdId);
    final profile = await api.me();
    state = SignedIn(profile);
  }

  /// Aliniază consimțământul `usageStats` de pe server cu alegerea locală (în ambele sensuri).
  /// Erorile se ignoră: se reîncearcă la următoarea autentificare sau schimbare.
  Future<void> syncUsageConsent() async {
    if (state is! SignedIn) return;
    final wanted = ref.read(settingsProvider).usageStats;
    try {
      final api = ref.read(authApiProvider);
      if (await api.usageStatsGranted() != wanted) {
        await api.setUsageStats(granted: wanted);
      }
    } on ApiError {
      // Fără efect vizibil.
    }
  }

  Future<void> _afterSignIn() async {
    await syncUsageConsent();
    await ref.read(usageTrackerProvider).flush();
  }

  /// Șterge tot ce ține de sesiune: tokenul (memorie + stocare), coada de statistici și starea
  /// ecranelor (sumele ascunse). Identificatorul instalării și setările rămân.
  Future<void> _wipeLocal({bool keepSessionExpired = false}) async {
    ref.read(tokenHolderProvider).value = null;
    ref
        .read(usageTrackerProvider)
        .clear(keepSessionExpired: keepSessionExpired);
    ref.read(hideAmountsProvider.notifier).reset();
    await ref.read(keyValueStoreProvider).delete(StoreKeys.sessionToken);
  }
}
