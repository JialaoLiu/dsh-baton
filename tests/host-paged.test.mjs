// The host tests again, against a Harness without sessionController.inspect (0.2.2 and later),
// which only has paged history. node --test runs each file in its own process, so the switch
// is set before the tests load.
process.env.DSHB_TEST_PAGED = '1'
await import('./host.test.mjs')
