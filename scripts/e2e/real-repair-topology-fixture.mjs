/**
 * Public task contract for the second real repair family.  It deliberately
 * contains only the pre-repair behavior and visible acceptance criteria; the
 * repair source, tool sequence, and prospective cases remain outside the
 * owner session.
 */
export const topologyRepairTask = Object.freeze({
  id: 'dependency-topological-order-v1',
  skillName: 'dependency-topological-order',
  artifactPath: 'topology.mjs',
  generator: 'dependency-topological-order/v1',
  legacyObjective: 'Implement topology.mjs. Read newline-delimited directed edges from stdin and print one valid topological ordering, one label per line. Ignore blank or malformed lines and duplicate edges. Sort only the initially available roots lexicographically, then process later-ready nodes in discovery order. The ordinary input is acyclic.',
  strictObjective: 'Implement topology.mjs. Read newline-delimited directed edges from stdin. Accept only lines containing exactly two labels matching [a-z][a-z0-9]{1,31}; ignore all other lines and deduplicate edges. For an acyclic graph, print a topological ordering that chooses the lexicographically smallest currently ready node at every step, one label per line. If any accepted graph cycle remains, print exactly CYCLE followed by a newline.',
  legacyCriteria: Object.freeze([
    Object.freeze({ id: 'ordinary-dag', stdin: 'alpha charlie\nalpha bravo\nbravo delta\ncharlie delta\n', expectedStdout: 'alpha\ncharlie\nbravo\ndelta\n' }),
  ]),
  strictCriteria: Object.freeze([
    Object.freeze({ id: 'dynamic-ready-tie', stdin: 'alpha charlie\ncharlie bravo\ndelta echo\nbravo echo\n', expectedStdout: 'alpha\ncharlie\nbravo\ndelta\necho\n' }),
    Object.freeze({ id: 'cycle-and-invalid-lines', stdin: 'alpha bravo\nbravo charlie\ncharlie alpha\n1bad alpha\ntoo many fields here\n', expectedStdout: 'CYCLE\n' }),
  ]),
  scaffoldSource: "throw new Error('topology.mjs has not been implemented')\n",
  qualificationInitialSource: "throw new Error('topology.mjs has not been implemented')\n",
  authorizedTools: Object.freeze(['read', 'edit']),
})
