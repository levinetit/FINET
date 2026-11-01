import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:go_router/go_router.dart';

import 'core/router.dart';
import 'core/theme/theme.dart';

/// Aplicația FINET: Material 3 din tokenii FINET, română, temă luminoasă și întunecată după
/// setarea telefonului.
class FinetApp extends StatefulWidget {
  const FinetApp({super.key, this.router});

  /// Router injectat în teste.
  final GoRouter? router;

  @override
  State<FinetApp> createState() => _FinetAppState();
}

class _FinetAppState extends State<FinetApp> {
  late final GoRouter _router = widget.router ?? buildRouter();

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
      routerConfig: _router,
    );
  }
}
