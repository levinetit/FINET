import 'package:flutter/material.dart';

import '../../core/widgets/finet_scaffold.dart';
import '../../core/widgets/states.dart';

/// Scanează: butonul central al navigării. Fotografierea și încărcarea bonurilor vin în Faza D
/// (`POST /api/v1/documents`); aici doar spunem asta, fără să simulăm o scanare.
class ScanScreen extends StatelessWidget {
  const ScanScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const FinetScaffold(
      title: 'Scanează',
      body: EmptyState(
        title: 'Scanarea bonurilor vine în curând',
        message: 'Vei putea fotografia un bon sau importa un PDF. Citirea o face serverul FINET.',
      ),
    );
  }
}
