import {test} from 'node:test';import assert from 'node:assert/strict';
import {expectedImageAssignment} from '../src/site-images';
import {runPool} from '../src/scheduling';
test('lazy-reader reassignment keeps admitted work alive, while a replacement source still cancels',async()=>{
  const expected='https://example.com/14.jpg',image={src:expected},aborter=new AbortController();
  let release!:()=>void,completed=0;const hold=new Promise<void>(resolve=>release=resolve);
  const run=runPool([0,1],2,async()=>{await hold;aborter.signal.throwIfAborted();completed++;},{stopped:()=>false,signal:aborter.signal});
  if(!expectedImageAssignment(image,'src',expected))aborter.abort();assert(!aborter.signal.aborted);
  // A lazy reader assigns the originally requested full-resolution URL again.
  image.src=expected;assert(expectedImageAssignment(image,'src',expected));release();await run;assert.equal(completed,2);
  image.src='https://example.com/15.jpg';assert(!expectedImageAssignment(image,'src',expected));
  assert(!expectedImageAssignment({src:expected,srcset:'https://example.com/large.jpg 2x'},'srcset',expected));
  assert(expectedImageAssignment({src:expected,srcset:''},'srcset',expected));
});
