import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/providers.dart';
import 'core/router.dart';
import 'core/theme/theme.dart';
import 'features/auth/session.dart';
import 'features/lock/app_lock.dart';

/// Aplicația FINET: Material 3 din tokenii FINET, română, temă luminoasă și întunecată după
/// setarea telefonului, blocare cu amprentă (opțională) și trimiterea statisticilor de utilizare.
class FinetApp extends ConsumerStatefulWidget {
  const FinetApp({super.key});

  @override
  ConsumerState<FinetApp> createState() => _FinetAppState();
}

class _FinetAppState extends ConsumerState<FinetApp>
    with WidgetsBindingObserver {
  Timer? _flushTimer;

  /// Evenimentele se trimit în loturi, cel mult o dată la câteva minute și la trecerea în fundal
  /// (promptul Android §10.1).
  static const _flushEvery = Duration(minutes: 3);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _flushTimer = Timer.periodic(_flushEvery, (_) => _flush());
  }

  @override
  void dispose() {
    _flushTimer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused) _flush();
  }

  void _flush() {
    if (ref.read(sessionProvider) is SignedIn) {
      unawaited(ref.read(usageTrackerProvider).flush());
    }
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: 'FINET',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      themeMode: ThemeMode.system,
      locale: const Locale('ro', 'RO'),
      supportedLocales: const [Locale('ro', 'RO')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      routerConfig: ref.watch(routerProvider),
      builder: (context, child) =>
          LockGate(child: child ?? const SizedBox.shrink()),
    );
  }
}
