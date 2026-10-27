CHANGELOG
=========

## 8.5.0 (2021-7-16)
@maxday Add a closingFlushInterval option which allows stopping quicker

## 8.4.0 (2021-7-3)
@roim Use errorHandler when possible on UDS socket replace error

## 8.3.2 (2021-5-29)
@cmaddalozzo Close unix domain socket after unsuccessful attempts to connect

## 8.3.1 (2021-4-1)
* @dvd-z Fix date_happened to allow usage of numbers

## 8.3.0 (2020-12-16)
* @chotiwat Handle UDS errors occurring when sending metrics

## 8.2.1 (2020-12-1)
* @stephenmathieson Make close callback optional in TypeScript definition

## 8.2.0 (2020-9-30)
* @dhermes Making UDS error handling and recovery more robust. Note these look to be ok in a minor release but are signficant upgrades to how UDS works. Thanks as well to @prognant for an overlapping PR.

## 8.1.0 (2020-9-25)
* @maleblond Support multiple values for the same tag key

## 8.0.0 (2020-9-23)
* @naseemkullah Change default value for 'host' from 'localhost' to
  undefined. This means the default host will now be 127.0.0.1 or ::1,
  which has cases where it will speed up sending metrics. This should be a
  non-breaking change, but bumping to a major version for it given
  it's a very base change to the library.
* @naseemkullah Switch from equals to strictEquals in tests

## 7.8.0 (2020-8-28)
* @bdeitte Fix some flaky tests
* @ralphiech Add missing error handler when socket is not created
* @ralphiech Add missing socket checks
* @dependabot Bump lodash from 4.17.15 to 4.17.19
* @DerGut Add "Congestion error" section to README

## 7.7.1 (2020-8-4)
* @DerGut Fix udsGracefulErrorHandling default value

## 7.7.0 (2020-7-29)
* @tebriel Add asyncDistTimer function

## 7.6.0 (2020-6-16)
* @Impeekay Add date type to timing function

## 7.5.0 (2020-6-5)
* @benblack86 Unreference underlying socket/interval to prevent process hangs

## 7.4.2 (2020-5-5)
* @kazk Fix types for set/unique

## 7.4.1 (2020-4-28)
* @lbeschastny Sanitize ',' tags characters for telegraf

## 7.4.0 (2020-4-3)
* @MichaelSitter add tagPrefix and tagSeparator options

## 7.3.0 (2020-4-1)
* @marciopd Use Date.now() instead of new Date()
* @chotiwat Add UDS graceful error handling options to typescript
* @bdeitte Update packages, most notably getting node-unix-dgram 2.0.4

## 7.2.0 (2020-3-19)
* @marciopd Add cacheDnsTtl
* @dependabot Bump acorn from 6.3.0 to 6.4.1

## 7.1.0 (2020-3-4)
* @wision Actually fix cachedDns with udp
* @casey-chow TypeScript: parameterize function types in timer and asyncTimer

## 7.0.0 (2020-2-13)
* @tomruggs Remove support for Node 6- now supporting Node 8.x or higher
* @tomruggs Update to the latest mocha version to get rid of a security warning

## 6.8.7 (2020-2-10)
* @mrknmc Fix TypeError when increment called without a callback argument

## 6.8.6 (2020-1-28)
* @ericmustin callback is not properly passed bytes argument

## 6.8.5 (2019-12-19)
* @bdeitte Fix for socket on reading when cacheDns and udp in use

## 6.8.4 (2019-12-18)
* @bdeitte Fix cacheDns with udp

## 6.8.3 (2019-12-15)
* @gleb-rudenko Fix StatsD constructor typing

## 6.8.2 (2019-11-12)
* @almandsky Fix useDefaultRoute to work again after abstract transports

## 6.8.1 (2019-10-16)
* @hayes Add unref method to transport interface

## 6.8.0 (2019-10-14)
* @runk Add new protocol, stream, and a stream parameter for
  specifying it.

## 6.7.0 (2019-10-9)
* @runk Code refactoring to have abstract transports

## 6.6.0 (2019-10-7)
* @NinjaBanjo @msiebuhr Add udsGracefulErrorHandling, ensuring uds
  handles socket errors gracefully

## 6.5.1 (2019-9-28)
* @msiebuhr Fix crasher when closing Unix Datagram Sockets without callback

## 6.5.0 (2019-9-22)
* @bdeitte Update decrement to handle missing arguments the same way
that increment does
* @bdeitte Document that memory may grow unbounded in mock mode
* @bdeitte Only load in unix-dgram library when uds protocol in use

## 6.4.1 (2019-9-19)
* @jfirebaugh Fix cacheDns option when obtaining host from DD_AGENT_HOST

## 6.4.0 (2019-6-28)
* @tghaas Add Node 12 support to uds protocol support
* @jhoch README clarifications

## 6.3.0 (2019-5-18)
* @paguillama Fix user defined tag example on README optional parameters
* @gabsn Initial support for uds protocol
* @bdeitte Updated and fixed up uds protocol support

## 6.2.0 (2019-4-10)
* @ahmed-mez Add support for env variables DD_AGENT_HOST,
DD_DOGSTATSD_PORT, and DD_ENTITY_ID
* @JamesMGreene Fix syntax in README example

## 6.1.1 (2019-1-8)
* @bdeitte Fix errorHandler to only happen again on errors
* @Ithildir Readme fixes

## 6.1.0 (2019-1-5)
* @bdeitte Ensure close() call always sends data before closing
* @bdeitte Recommend errorHandler over client.socket.on() for handling
errors
* @mbellerose Fix the timer function type definition

## 6.0.1 (2018-12-17)
* @msmnc Fix regression when tag value is a number
* @bdeitte Make non-options in constructor more deprecated

## 6.0.0 (2018-12-15)
@bdeitte Major upgrade to the codebase to be more modern,
overhaul tests, and many small tweaks.  Most of this is internal to
the project, but there are a few changes to note for everyone:
* Now requires Node 6 or above
* Update close() to handle errors better, not doubling up in error
messages and not leaving uncaught errors

Everything else done here should be internal facing.  Those changes
include:
* Use "lebab" to ES6-ify the project
* Switch from jshint and eslint and make syntax updates based on this
* Remove a lot of duplication in tests and many small fixups in tests
* Start using Mocha 4
* Stop using index.js for testing
* Start using the code coverage report as part of the build
* Remove the ignoring of errors on close of tests, and tear down tests in general better
* Stop using "new Buffer", that is deprecated, and use Buffer.from() instead

## 5.9.2 (2018-11-10)
* @stieg Add mockBuffer to types

## 5.9.1 (2018-9-18)
* @etaoins Add asyncTimer types
* @blimmer: Add increment doc snippet

## 5.9.0 (2018-7-27)
* @chrismatheson: Fix timer to have duration in microseconds (was nanoseconds)
* @chrismatheson: Add asyncTimer functionality

## 5.8.0 (2018-7-17)
* @michalholasek Clean up code formatting and split up tests
* @michalholasek Add tcp protocol support
* @remie Add tcp protocol support

## 5.7.0 (2018-7-4)
* @Willyham Add support for recording buffers in mock mode

## 5.6.3 (2018-6-20)
* @singerb correct close() type definition

## 5.6.2 (2018-6-15)
* @mjesuele Fix time in timer

## 5.6.1 (2018-6-4)
* @MattySheikh Typescript: add socket type for StatsD class

## 5.6.0 (2018-6-3)
* @drewen TypeScript: add overload types for stats functions

## 5.5.1 (2018-5-30)
* @emou Typescript declaration for the 'timer' method

## 5.5.0 (2018-5-30)
* @drewen Split up single file, add code coverage capabilities

## 5.4.1 (2018-5-12)
* @jasonsack Fixups for new useDefaultRoute option
* @bdeitte Test against more modern set of Node versions in Travis

## 5.4.0 (2018-4-26)
* @RobGraham Added `distribution()` support for DataDog v6

## 5.3.0 (2018-4-3)
* @tanelso2 Added support for using default route on Linux

## 5.2.0 (2018-2-28)
* @ericapisani Add timer decorator function

## 5.1.0 (2018-2-14)
* @lautis Pass key-value tags as objects

## 5.0.1 (2018-2-2)
* @punya-asapp Add childClient to TypeScript types

## 5.0.0 (2017-11-9)
* @jgwmaxwell TypeScript typings, resolving the default export issue and missing options from last time.  This is being marked as a major release, in caution given the revert last time, but it is not actually known to cause any backwards-compatible issues.

## 4.8.0 (2017-10-31)
* @Jiggmin concat prefix and suffix in check function
* @Jiggmin commit package-lock.json

## 4.7.1 (2017-10-31)
* @Jiggmin Add backwards compatibility for global_tags

## 4.7.0 (2017-9-21)
* @bdeitte Revert TypeScript typings, which ended up not being semver minor

## 4.6.0 (2017-9-19)
* @jgwmaxwell TypeScript typings

## 4.5.0 (2017-5-4)
* @jsocol Support default value with tags in increment

## 4.4.0 (2017-3-23)
* @RijulB Global sample rate

## 4.3.1 (2016-11-7)
* @RandomSeeded Fix callbacks not being triggered when using buffers

## 4.3.0 (2016-9-30)
* @ggoodman Allow socket errors to be handled with errorHandler

## 4.2.0 (2016-8-3)
* @mhahn Add support for DataDog service checks

## 4.1.1 (2016-5-22)
* @ash2k date_happened should be seconds, not milliseconds

## 4.1.0 (2016-5-8)
* @ash2k Support multiline text in DataDog events

## 4.0.0 (2016-5-7)
* @ash2k Provided tags, including `childClient()` tags, override global tags with same names.

## 3.1.0 (2016-5-3)
* @ash2k Support a client-wide error handler used in case no callback is provided and to handle various exceptions.

## 3.0.1 (2016-4-28)
* @bdeitte Add 'use strict' to files and make changes needed for this.

## 3.0.0 (2016-4-27)
* @ash2k Method to create child clients.  (This is not a backwards-incompatible change but is rather large.)
* @ash2k Shrink npm package a bit more

## 2.4.0 (2016-2-26)
* @arlolra Shrink npm package
* @arlolra/@bdeitte Move DNS errors when caching them to send() and use callback when possible
* @bdeitte Use callback for Telegraf error when possible

## 2.3.1 (2016-2-3)
* @Pchelolo Ensure messages not larger then maxBufferSize

## 2.3.0 (2016-1-17)
* @bdeitte Fix increment(name, 0) to send a 0 count instead of 1
* @bdeitte Flush the queue when needed on close()

## 2.2.0 (2016-1-10)
* @bdeitte Document and expand on close API
* @bdeitte Catch more error cases for callbacks

## 2.1.2 (2015-12-9)
* @bdeitte Even more doc updates
* @mmoulton Fix multiple tags with Telegraf

## 2.1.1 (2015-12-9)
* @bdeitte Doc updates

## 2.1.0 (2015-12-9)
* @mmoulton Add options.telegraf to enable support for Telegraf's StatsD line protocol format
* @mmoulton Ensure message callback is sent in buffered case, even when we just buffer.

## 2.0.0 (2015-10-22)
* @jjofseattle Add options.maxBufferSize and options.bufferFlushInterval
* @bdeitte Change options.global_tags to options.globalTags for consistency

## 1.0.2 (2015-09-25)
* @ainsleyc Thrown error when cacheDNS flag fails to resolve DNS name

## 1.0.1 (2015-09-24)
* @bdeitte Add the event API used by DogStatsD
* @sivy Start from the base of https://github.com/sivy/node-statsd
