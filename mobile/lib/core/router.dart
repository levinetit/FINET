import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../features/home/home_screen.dart';
import '../features/more/more_screen.dart';
import '../features/reports/reports_screen.dart';
import '../features/scan/scan_screen.dart';
import '../features/transactions/transactions_screen.dart';

/// Rutele aplicației: navigarea de jos cu cinci ramuri (Acasă, Tranzacții, Scanează, Rapoarte,
/// Mai mult), fiecare cu starea ei păstrată la schimbarea tabului.
GoRouter buildRouter({String initialLocation = '/'}) {
  return GoRouter(
    initialLocation: initialLocation,
    routes: [
      StatefulShellRoute.indexedStack(
        builder: (context, state, shell) => _Shell(shell: shell),
        branches: [
          StatefulShellBranch(
            routes: [GoRoute(path: '/', builder: (_, _) => const HomeScreen())],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/transactions',
                builder: (_, _) => const TransactionsScreen(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(path: '/scan', builder: (_, _) => const ScanScreen()),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/reports',
                builder: (_, _) => const ReportsScreen(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(path: '/more', builder: (_, _) => const MoreScreen()),
            ],
          ),
        ],
      ),
    ],
  );
}

class _Shell extends StatelessWidget {
  const _Shell({required this.shell});
  final StatefulNavigationShell shell;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: shell,
      bottomNavigationBar: NavigationBar(
        selectedIndex: shell.currentIndex,
        onDestinationSelected: (i) =>
            shell.goBranch(i, initialLocation: i == shell.currentIndex),
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.home_outlined),
            selectedIcon: Icon(Icons.home),
            label: 'Acasă',
          ),
          NavigationDestination(
            icon: Icon(Icons.swap_vert),
            selectedIcon: Icon(Icons.swap_vert),
            label: 'Tranzacții',
          ),
          NavigationDestination(
            icon: Icon(Icons.document_scanner_outlined),
            selectedIcon: Icon(Icons.document_scanner),
            label: 'Scanează',
          ),
          NavigationDestination(
            icon: Icon(Icons.bar_chart_outlined),
            selectedIcon: Icon(Icons.bar_chart),
            label: 'Rapoarte',
          ),
          NavigationDestination(
            icon: Icon(Icons.more_horiz),
            selectedIcon: Icon(Icons.more_horiz),
            label: 'Mai mult',
          ),
        ],
      ),
    );
  }
}
