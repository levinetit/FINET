import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';
import '../state/privacy.dart';
import 'logo.dart';

/// Cadrul comun al ecranelor: logo-ul în bara de sus și comutatorul „ascunde sumele”.
class FinetScaffold extends ConsumerStatefulWidget {
  const FinetScaffold({
    super.key,
    required this.title,
    required this.body,
    this.screen,
    this.floatingActionButton,
  });

  final String title;
  final Widget body;

  /// Numele ecranului pentru `screen_view` (statistici), la prima afișare. Taburile principale
  /// își raportează ecranul din navigarea de jos, nu de aici.
  final String? screen;
  final Widget? floatingActionButton;

  @override
  ConsumerState<FinetScaffold> createState() => _FinetScaffoldState();
}

class _FinetScaffoldState extends ConsumerState<FinetScaffold> {
  @override
  void initState() {
    super.initState();
    final screen = widget.screen;
    if (screen != null) ref.read(usageTrackerProvider).screen(screen);
  }

  @override
  Widget build(BuildContext context) {
    final hidden = ref.watch(hideAmountsProvider);
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 16,
        title: Row(
          children: [
            const FinetLogo(height: 24),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                widget.title,
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
          ],
        ),
        actions: [
          IconButton(
            tooltip: hidden ? 'Arată sumele' : 'Ascunde sumele',
            icon: Icon(
              hidden
                  ? Icons.visibility_off_outlined
                  : Icons.visibility_outlined,
            ),
            onPressed: () => ref.read(hideAmountsProvider.notifier).toggle(),
          ),
        ],
      ),
      body: Column(children: [Expanded(child: widget.body)]),
      floatingActionButton: widget.floatingActionButton,
    );
  }
}
